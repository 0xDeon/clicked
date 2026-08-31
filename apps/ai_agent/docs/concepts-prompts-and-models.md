# Prompts and model configuration

The system prompts behind each LLM-backed endpoint, the model used per endpoint, how raw model output is parsed back into typed responses, and what happens when the model returns something malformed.

Everything here reflects [apps/ai_agent/main.py](../main.py) as implemented. Prompts are reproduced **verbatim** — if you change one in code, change it here in the same commit, because a drifted prompt doc is worse than no prompt doc.

## Models at a glance

| Endpoint               | Model                    | Call type       | JSON mode | Timeout |
| ---------------------- | ------------------------ | --------------- | --------- | ------- |
| `POST /chat`           | `gpt-4o-mini`            | chat completion | no        | 30s     |
| `POST /transfers/analyse` | `gpt-4o-mini`         | chat completion | **yes**   | 10s     |
| `POST /proposals/summarise` | `gpt-4o-mini`       | chat completion | **yes**   | 10s     |
| `POST /index/message`  | `text-embedding-3-small` | embedding       | n/a       | none    |
| `GET /search`          | `text-embedding-3-small` | embedding       | n/a       | none    |

Model identifiers are **hardcoded string literals at each call site**. There is no configuration object, no environment variable, and no central constant. Changing a model means editing `main.py`.

`GET /health` involves no model at all.

## The prompts

### `POST /chat` — system prompt

This is the only true *system* prompt in the service. It is a module-level constant, applied to every `/chat` request:

```python
_SYSTEM_PROMPT = (
    "You are an AI assistant for Clicked, a decentralised messaging and payment "
    "platform built on the Stellar blockchain. Clicked lets users send token "
    "payments inside chat conversations, manage group treasuries, and participate "
    "in DAO-style governance. Help users with questions about transactions, wallet "
    "management, group finances, and platform features."
)
```

Assembled as:

```python
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": request.message},
    ],
    timeout=30,
)
```

**Behaviour it is designed to produce.** The prompt does one job: domain grounding. It tells the model what Clicked is (decentralised messaging + payments), what chain it runs on (Stellar), what users can do (in-chat payments, group treasuries, DAO governance), and which question areas are in scope (transactions, wallet management, group finances, platform features). Without it the model would answer Stellar questions generically and would have no idea what "group treasury" means in this product.

Three properties of this prompt matter operationally:

- **It does not constrain output format.** `/chat` returns free-form prose; there is no JSON mode and no schema. The reply is passed through unmodified.
- **It does not constrain output length.** There is no `max_tokens`, so response length — and cost — is bounded only by the model.
- **It carries no conversation history.** Each request sends exactly two messages: system and the current user turn. `ChatRequest.conversation_id` is accepted and validated by Pydantic but **is never sent to the model and never used to load prior turns**. `/chat` is stateless and single-turn despite the field's name implying otherwise.

`test_system_prompt_contains_context` in [tests/test_chat.py](../tests/test_chat.py) pins the presence of the "Clicked", "Stellar", and messaging/payment grounding, so gutting the prompt fails CI.

### `POST /transfers/analyse` — user prompt

No system message. The whole instruction is a single user-role message, built per request:

```python
    prompt = (
        "Analyse this Stellar transfer for fraud risk.\n"
        f"Amount: {request.amount} XLM\n"
        f"Sender: {request.sender}\n"
        f"Recipient: {request.recipient}\n"
        f"Memo: {request.memo}\n\n"
        "Reply with JSON only using keys: flagged (bool), reason (string under 100 chars or null), "
        "confidence (float 0-1). Flag if suspicious patterns are detected."
    )
```

Sent as:

```python
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": prompt}],
    response_format={"type": "json_object"},
    timeout=10,
)
```

**Behaviour it is designed to produce.** A three-key JSON verdict — `flagged`, `reason`, `confidence` — matching the `TransferAnalyseResponse` shape field for field. The `reason` length hint keeps the string renderable in a UI, and the `confidence` range makes the score comparable across calls. `response_format={"type": "json_object"}` puts the model in JSON mode so output is guaranteed to be syntactically valid JSON — though *not* guaranteed to contain the keys asked for, which is the whole reason the parsing layer below exists.

**This prompt is only reached for transfers at or below the threshold.** Amounts strictly greater than `_HIGH_VALUE_THRESHOLD` (`10_000.0`) return a rule-based verdict without any model call:

```python
if request.amount > _HIGH_VALUE_THRESHOLD:
    return TransferAnalyseResponse(
        flagged=True,
        reason=f"Amount {request.amount} XLM exceeds {_HIGH_VALUE_THRESHOLD} XLM threshold",
        confidence=0.99,
    )
```

The high-value flag is deliberately not delegated to the model — it is a security property that must not depend on model behaviour. See [concepts-transfer-risk-analysis.md](concepts-transfer-risk-analysis.md) for the rationale.

### `POST /proposals/summarise` — user prompt

Again a single user-role message, no system message:

```python
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
```

Sent as:

```python
response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": prompt}],
    response_format={"type": "json_object"},
    timeout=10,
)
```

**Behaviour it is designed to produce.** Two outputs in one call. The `summary` is constrained to *exactly two sentences* and to plain English, because it renders in a fixed-size UI slot and is read by voters who will not read the full proposal. The `risk` field is constrained to a closed three-value set, and — unlike the transfer prompt — the prompt supplies an explicit rubric for choosing between them: `high` for large amounts, unclear intent, or obvious red flags; `low` for small, well-scoped, low-impact proposals; `medium` otherwise. `medium` is the stated default, which matters because it is also the code's fallback (see below), so a malformed response degrades toward the same value the rubric already treats as neutral.

### Embedding calls — `/index/message` and `/search`

No prompt. Both endpoints embed raw text directly with `text-embedding-3-small`:

```python
# /index/message
res = openai_client.embeddings.create(input=request.content, model="text-embedding-3-small")
vector = res.data[0].embedding

# /search
res = openai_client.embeddings.create(input=q, model="text-embedding-3-small")
vector = res.data[0].embedding
```

**Both sides must use the same model.** Vectors from different embedding models are not comparable, so a query embedded with one model against a corpus indexed with another returns semantically meaningless results — with no error. This is the most dangerous coupling in the service; see [Changing a model safely](#changing-a-model-safely).

## Output parsing and validation

Each endpoint hands model output back through a different amount of validation. Ordered from least to most defensive:

### `/chat` — no parsing

```python
return ChatResponse(reply=response.choices[0].message.content)
```

The content string is passed straight into `ChatResponse`. There is no JSON parsing and no content validation.

One sharp edge: the OpenAI API can return `None` for `message.content` (for example on a content-filter stop). `ChatResponse.reply` is typed `str`, so a `None` raises a Pydantic `ValidationError` inside the handler, which surfaces to the caller as an unhandled `500`. There is no explicit guard for this case.

### `/transfers/analyse` — parse with per-field defaults

This is the worked example the parsing strategy is best understood through:

```python
result = json.loads(response.choices[0].message.content)
return TransferAnalyseResponse(
    flagged=bool(result.get("flagged", False)),
    reason=result.get("reason"),
    confidence=float(result.get("confidence", 0.0)),
)
```

Every field is read with `.get()` and a default, so a **partial** JSON object still produces a valid typed response:

| Model returns | Parsed result | Rationale |
| ------------- | ------------- | --------- |
| `{"flagged": true, "reason": "Suspicious memo", "confidence": 0.9}` | `flagged=True, reason="Suspicious memo", confidence=0.9` | Complete response, passed through. |
| `{"flagged": false, "reason": null}` — **`confidence` missing** | `flagged=False, reason=None, **confidence=0.0**` | `.get("confidence", 0.0)` supplies `0.0`. |
| `{"reason": null, "confidence": 0.5}` — **`flagged` missing** | **`flagged=False`**, `reason=None, confidence=0.5` | `.get("flagged", False)` supplies `False`. |
| `{}` | `flagged=False, reason=None, confidence=0.0` | Both defaults apply. |

**The two defaults fail in opposite directions, and the asymmetry is intentional.**

A missing `flagged` defaults to `False` — *do not flag*. A missing `confidence` defaults to `0.0` — *no confidence at all*. So a model that omits `flagged` produces a "not flagged" verdict, and a model that omits `confidence` produces a verdict the caller can see is worthless. A consumer that reads `confidence` before acting on `flagged` will correctly distrust both malformed cases. A consumer that reads `flagged` alone will silently treat a malformed response as a clean transfer.

**This is the operationally important consequence: on this endpoint, model failure looks like "transfer is fine".** Callers making a security decision must gate on `confidence`, not on `flagged` alone. Both default paths are pinned by `test_llm_path_missing_confidence_defaults_to_zero` and `test_llm_path_missing_flagged_defaults_to_false` in [tests/test_transfers.py](../tests/test_transfers.py).

Note also that `confidence` is **not range-checked**. The prompt asks for `0-1`, but a model returning `7.5` produces `confidence=7.5`; `float()` only enforces the type. Similarly `reason` has no length check despite the prompt's "under 100 chars".

If the model returns syntactically invalid JSON, `json.loads` raises and the request fails as an unhandled `500`. JSON mode makes this unlikely but not impossible (a response truncated by the token limit is still invalid JSON). There is no `try/except` around the parse.

### `/proposals/summarise` — parse, reject, then clamp

The most defensive of the three, and the only one that deliberately returns a `502`:

```python
result = json.loads(response.choices[0].message.content)

summary = (result.get("summary") or "").strip()
if not summary:
    raise HTTPException(status_code=502, detail="LLM did not return a summary")

risk = str(result.get("risk", "")).strip().lower()
if risk not in ("low", "medium", "high"):
    # Defensive fallback: never return an invalid risk level to the caller.
    risk = "medium"

# Pydantic re-validates via response_model before the response is sent.
return ProposalSummariseResponse(
    summary=summary, risk=cast(Literal["low", "medium", "high"], risk)
)
```

The two fields are handled by opposite strategies, because their failure modes differ in kind:

- **`summary` is mandatory — a missing one is an error.** Absent, `null`, empty, or whitespace-only all collapse to `""` via `(... or "").strip()` and raise `502 "LLM did not return a summary"`. There is no sensible fabricated summary, so the endpoint fails loudly rather than returning an empty string that would render as a blank card.
- **`risk` is clamped — an invalid one degrades.** The value is normalised (`str()`, `.strip()`, `.lower()`, so `"HIGH"` and `" high "` both survive) and checked against the closed set. Anything else — a missing key, `"critical"`, `"unknown"`, `null` — becomes `"medium"`. Returning an out-of-set risk would break `RiskLevel` typing for every downstream consumer, so the code guarantees a valid value.

`"medium"` is a reasonable clamp target precisely because it is also the prompt's stated default for the unremarkable case. But note the ambiguity it creates: **a `risk` of `"medium"` may mean the model judged the proposal middling, or that it returned garbage.** The two are indistinguishable to the caller, and no signal is logged. Do not treat `"medium"` as a confident assessment.

The `cast()` is a static-typing assertion only — it performs no runtime check. The real runtime guarantee comes from `response_model=ProposalSummariseResponse` on the route decorator, which re-validates the outgoing payload against the `RiskLevel` literal before it is serialised.

### Parsing strategy summary

| Endpoint | Malformed field | Behaviour | Caller sees |
| -------- | --------------- | --------- | ----------- |
| `/chat` | content is `None` | Pydantic `ValidationError`, unhandled | `500` |
| `/transfers/analyse` | invalid JSON | `json.loads` raises, unhandled | `500` |
| `/transfers/analyse` | `flagged` missing | defaults to `False` | `200`, unflagged |
| `/transfers/analyse` | `confidence` missing | defaults to `0.0` | `200`, zero confidence |
| `/transfers/analyse` | `confidence` out of range | passed through unchecked | `200`, e.g. `7.5` |
| `/proposals/summarise` | invalid JSON | `json.loads` raises, unhandled | `500` |
| `/proposals/summarise` | `summary` missing/empty | explicit rejection | `502` |
| `/proposals/summarise` | `risk` missing/invalid | clamped to `"medium"` | `200` |

The typed response shapes themselves are documented in [contracts-pydantic-models.md](contracts-pydantic-models.md).

## Changing a model safely

Model IDs are string literals at each call site, so a change is a code edit and a deploy. The safe procedure differs sharply between the two model families.

### Changing a chat model

Applies to `/chat`, `/transfers/analyse`, and `/proposals/summarise`.

1. **Confirm JSON mode support.** `/transfers/analyse` and `/proposals/summarise` pass `response_format={"type": "json_object"}`. A model that does not support it will error on every request. `/chat` does not use JSON mode and is unconstrained here.
2. **Change one endpoint at a time.** The three call sites are independent — there is no shared constant — so a model change is naturally scoped to one endpoint. Keep it that way; do not sweep all three in one edit.
3. **Re-test the parse layer, not just the happy path.** A new model may phrase `risk` differently (triggering the `"medium"` clamp more often) or omit `confidence` more frequently (silently producing unflagged verdicts). The defaults will hide this — no error, no log, just quietly degraded output. Diff real outputs before and after.
4. **Re-check the timeouts.** `/transfers/analyse` and `/proposals/summarise` allow only 10s. A slower or reasoning-style model can exceed that and turn a working endpoint into a timeout.
5. **Re-check cost.** There is no `max_tokens` on any call, so a more expensive model multiplies cost directly with no ceiling. See [operations.md](operations.md#cost-controls-on-the-llm-path).
6. **Update `test_correct_model_used`** in [tests/test_chat.py](../tests/test_chat.py), which asserts the `/chat` model literal and will fail on any change.

Changing a chat model is reversible: revert the literal and redeploy.

### Changing the embedding model

**This is not a routine change and is not reversible by redeploy alone.**

`text-embedding-3-small` appears at two call sites — the write path in `/index/message` and the read path in `/search`. Vectors produced by different embedding models occupy different spaces and are not comparable. Changing the model on only one side produces a search that returns confident nonsense with **no error and no warning**. Changing it on both sides leaves every previously indexed message in the old space, which is the same failure for all existing data.

A correct migration requires:

1. Change the literal at **both** call sites in the same commit.
2. Re-embed and re-index the entire existing `Message` corpus with the new model.
3. Cut over reads only once the re-index is complete — ideally via a new collection and an atomic switch, since `/search` against a half-migrated corpus silently mixes both spaces.

Also confirm the new model's dimensionality is compatible with the `Message` collection configuration before starting — see [contracts-weaviate-schema.md](contracts-weaviate-schema.md).

## Privacy boundary

**What leaves the system.** Every LLM-backed endpoint sends its payload to OpenAI, the sole external model provider. Specifically:

| Endpoint | Sent to OpenAI |
| -------- | -------------- |
| `POST /chat` | The `_SYSTEM_PROMPT` and the full `message` string, verbatim |
| `POST /transfers/analyse` | `amount`, `sender`, `recipient`, `memo` — interpolated into the prompt (LLM path only) |
| `POST /proposals/summarise` | `title`, `description`, `amount` — interpolated into the prompt |
| `POST /index/message` | The full `content` string of the message being indexed |
| `GET /search` | The full `q` query string |

Two of these deserve emphasis. **`/transfers/analyse` transmits both Stellar addresses and the transfer memo** — the memo is application-controlled and may carry a chat message reference or user-supplied text. **`/index/message` transmits the complete plaintext body of every indexed message**, which makes it the single largest flow of user content to a third party in the service.

**What never leaves the system.**

- **`OPENAI_API_KEY`** is used to authenticate to OpenAI and is never placed in a prompt.
- **`ChatRequest.conversation_id`** is accepted and validated but never sent to the model — `/chat` builds its message list from `request.message` alone.
- **`IndexMessageRequest.messageId`, `conversationId`, and `senderId`** are never sent to OpenAI. Only `content` is embedded. The identifiers are written to Weaviate as properties alongside the vector, so **message content reaches OpenAI while message metadata stays local**.
- **The `conversationId` filter on `/search`** is applied inside Weaviate via `Filter.by_property("conversationId").equal(conversationId)`, not by the model. Conversation scoping is enforced locally.
- **The stored vectors and all Weaviate contents.** Weaviate is a local dependency (`connect_to_local()`); the corpus is never shipped to the model provider. Only the text being embedded transits, one call at a time.
- **Everything on the `/transfers/analyse` rule-based path.** Transfers above `10_000.0` XLM are resolved entirely in-process with no network call, so their addresses and memos never reach OpenAI at all.
- **`GET /health`** involves no external call whatsoever.

**Boundary properties to be aware of.**

- **The service performs no redaction, masking, or PII stripping.** Whatever the caller supplies is what the provider receives.
- **Message content sent to OpenAI is plaintext at that point.** Whatever end-to-end encryption applies in the wider platform (see [apps/web/docs/concepts-e2ee-architecture.md](../../web/docs/concepts-e2ee-architecture.md)) does not extend to `/index/message`: the endpoint receives and forwards cleartext. Indexing a message is a deliberate decision to expose its content to the model provider.
- **Retention is governed by the OpenAI account's data policy**, not by this service. The service keeps no record of what it sent — no prompt logging, no request archive.
- **There is no authentication on any endpoint.** Any party able to reach the service can cause data to be sent to OpenAI under your account. Network isolation is the controlling mitigation — see [operations.md](operations.md#known-operational-risks).

## Related documents

- [Operations guide](operations.md) — running the service, health checks, scaling, cost controls
- [Testing guide](testing.md) — testing prompt and parsing behaviour without a real model
- [Pydantic models](contracts-pydantic-models.md) — the typed request/response shapes
- [Transfer risk analysis](concepts-transfer-risk-analysis.md) — why the high-value rule bypasses the model
- [RAG search architecture](concepts-rag-search-architecture.md) — how embeddings are indexed and retrieved
- [Weaviate schema](contracts-weaviate-schema.md) — the `Message` collection and vector configuration
- [Chat API](api-chat.md) · [Transfers analyse API](api-transfers-analyse.md) · [Proposals summarise API](api-proposals-summarise.md) · [Index and search API](api-index-search.md)
