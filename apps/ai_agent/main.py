import json
import os
from typing import Literal

import uvicorn
import weaviate
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from weaviate.classes.query import Filter

app = FastAPI(title="AI Agent API")

_SYSTEM_PROMPT = (
    "You are an AI assistant for Clicked, a decentralised messaging and payment "
    "platform built on the Stellar blockchain. Clicked lets users send token "
    "payments inside chat conversations, manage group treasuries, and participate "
    "in DAO-style governance. Help users with questions about transactions, wallet "
    "management, group finances, and platform features."
)

_HIGH_VALUE_THRESHOLD = 10_000.0


# ── Request / response models ─────────────────────────────────────────────────


class ChatRequest(BaseModel):
    message: str
    conversation_id: str


class ChatResponse(BaseModel):
    reply: str


class TransferAnalyseRequest(BaseModel):
    amount: float
    sender: str
    recipient: str
    memo: str


class TransferAnalyseResponse(BaseModel):
    flagged: bool
    reason: str | None
    confidence: float


class IndexMessageRequest(BaseModel):
    messageId: str
    conversationId: str
    senderId: str
    content: str


RiskLevel = Literal["low", "medium", "high"]


class ProposalSummariseRequest(BaseModel):
    title: str
    description: str
    amount: float


class ProposalSummariseResponse(BaseModel):
    summary: str
    risk: RiskLevel


# ── Helpers ───────────────────────────────────────────────────────────────────


def _openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")
    from openai import OpenAI  # imported lazily so missing package gives a clear error

    return OpenAI(api_key=api_key)


# ── Endpoints ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    client = _openai_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": request.message},
        ],
        timeout=30,
    )
    return ChatResponse(reply=response.choices[0].message.content)


@app.post("/transfers/analyse", response_model=TransferAnalyseResponse)
def analyse_transfer(request: TransferAnalyseRequest):
    # Rule-based: high-value transfers are always flagged with high confidence.
    if request.amount > _HIGH_VALUE_THRESHOLD:
        return TransferAnalyseResponse(
            flagged=True,
            reason=f"Amount {request.amount} XLM exceeds {_HIGH_VALUE_THRESHOLD} XLM threshold",
            confidence=0.99,
        )

    client = _openai_client()
    prompt = (
        "Analyse this Stellar transfer for fraud risk.\n"
        f"Amount: {request.amount} XLM\n"
        f"Sender: {request.sender}\n"
        f"Recipient: {request.recipient}\n"
        f"Memo: {request.memo}\n\n"
        "Reply with JSON only using keys: flagged (bool), reason (string under 100 chars or null), "
        "confidence (float 0-1). Flag if suspicious patterns are detected."
    )
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        timeout=10,
    )
    result = json.loads(response.choices[0].message.content)
    return TransferAnalyseResponse(
        flagged=bool(result.get("flagged", False)),
        reason=result.get("reason"),
        confidence=float(result.get("confidence", 0.0)),
    )


@app.post("/proposals/summarise", response_model=ProposalSummariseResponse)
def summarise_proposal(request: ProposalSummariseRequest):
    client = _openai_client()
    prompt = (
        "Summarise this Clicked governance proposal for a frontend reader and "
        "rate its risk level.\n"
        f"Title: {request.title}\n"
        f"Description: {request.description}\n"
        f"Amount: {request.amount} XLM\n\n"
        "Reply with JSON only using keys: summary (a plain-English summary of "
        'exactly 2 sentences), risk (one of "low", "medium", "high"). '
        'Use "high" for large amounts, unclear intent, or obvious red flags; '
        '"low" for small, well-scoped, low-impact proposals; otherwise "medium".'
    )
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        timeout=10,
    )
    result = json.loads(response.choices[0].message.content)

    summary = (result.get("summary") or "").strip()
    if not summary:
        raise HTTPException(status_code=502, detail="LLM did not return a summary")

    risk = str(result.get("risk", "")).strip().lower()
    if risk not in ("low", "medium", "high"):
        # Defensive fallback: never return an invalid risk level to the caller.
        risk = "medium"

    # Pydantic re-validates via response_model before the response is sent.
    return ProposalSummariseResponse(summary=summary, risk=risk)


@app.post("/index/message")
def index_message(request: IndexMessageRequest):
    try:
        # Attempt connection to Weaviate
        client = weaviate.connect_to_local()
    except Exception:
        raise HTTPException(status_code=503, detail="Weaviate connection failed")

    try:
        if not client.collections.exists("Message"):
            client.collections.create(name="Message")

        collection = client.collections.get("Message")

        # Get embedding via OpenAI
        openai_client = _openai_client()
        res = openai_client.embeddings.create(input=request.content, model="text-embedding-3-small")
        vector = res.data[0].embedding

        # Upsert
        if collection.data.exists(request.messageId):
            collection.data.replace(
                uuid=request.messageId,
                properties={
                    "conversationId": request.conversationId,
                    "messageId": request.messageId,
                    "senderId": request.senderId,
                    "content": request.content,
                },
                vector=vector,
            )
        else:
            collection.data.insert(
                uuid=request.messageId,
                properties={
                    "conversationId": request.conversationId,
                    "messageId": request.messageId,
                    "senderId": request.senderId,
                    "content": request.content,
                },
                vector=vector,
            )
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        client.close()

    return {"status": "ok"}


@app.get("/search")
def search_messages(q: str, conversationId: str):
    try:
        client = weaviate.connect_to_local()
    except Exception:
        raise HTTPException(status_code=503, detail="Weaviate connection failed")

    try:
        if not client.collections.exists("Message"):
            return {"results": []}

        collection = client.collections.get("Message")

        # Get embedding for query
        openai_client = _openai_client()
        res = openai_client.embeddings.create(input=q, model="text-embedding-3-small")
        vector = res.data[0].embedding

        results = collection.query.near_vector(
            near_vector=vector,
            limit=5,
            filters=Filter.by_property("conversationId").equal(conversationId),
        )

        hits = []
        for obj in results.objects:
            hits.append(
                {
                    "messageId": obj.properties.get("messageId"),
                    "conversationId": obj.properties.get("conversationId"),
                    "senderId": obj.properties.get("senderId"),
                    "content": obj.properties.get("content"),
                }
            )

        return {"results": hits}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        client.close()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
