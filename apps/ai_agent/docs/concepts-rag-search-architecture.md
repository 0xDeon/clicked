# RAG / Semantic Search Architecture

## Overview

The Clicked AI Agent implements a Retrieval-Augmented Generation (RAG) pipeline for semantic message search. This architecture allows users to search across their conversation history using natural language queries, finding semantically relevant messages even when they don't contain exact keyword matches.

The pipeline has two phases: **indexing** (storing messages with their vector embeddings) and **retrieval** (finding relevant messages via similarity search).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INDEXING PIPELINE                             │
│                                                                      │
│  Caller ──POST /index/message──▶ FastAPI                             │
│                                       │                              │
│                                       ▼                              │
│                              OpenAI Embeddings API                   │
│                              (text-embedding-3-small)                │
│                                       │                              │
│                                       ▼                              │
│                              Weaviate Vector Database                │
│                              (insert/replace "Message" collection)   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       RETRIEVAL PIPELINE                             │
│                                                                      │
│  Caller ──GET /search?q=...&conversationId=...──▶ FastAPI             │
│                                                       │              │
│                                                       ▼              │
│                                              OpenAI Embeddings API   │
│                                              (text-embedding-3-small)│
│                                                       │              │
│                                                       ▼              │
│                                              Weaviate Vector Database │
│                                              (near_vector query,     │
│                                               filtered by            │
│                                               conversationId,        │
│                                               top 5 results)         │
│                                                       │              │
│                                                       ▼              │
│                                              JSON response with      │
│                                              ranked results          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Indexing Pipeline: `POST /index/message`

### Step-by-step flow

1. **Request arrives** — The caller sends a JSON body with `messageId`, `conversationId`, `senderId`, and `content`.
2. **Weaviate connection** — The endpoint connects to a local Weaviate instance via `weaviate.connect_to_local()`.
3. **Collection creation** — If the `"Message"` collection does not yet exist, it is created automatically.
4. **Embedding generation** — The message `content` is sent to OpenAI's `text-embedding-3-small` model, which returns a dense vector embedding (typically 1536 dimensions).
5. **Upsert to Weaviate**:
   - If the `messageId` already exists in the collection → **replace** the existing record (handles edited messages)
   - If the `messageId` is new → **insert** a new record
   - Both operations store: `conversationId`, `messageId`, `senderId`, `content` (as properties) + the embedding vector

### What gets embedded

- **Only the message `content`** is embedded. Metadata fields (`messageId`, `conversationId`, `senderId`) are stored as filterable properties but are **not** part of the embedding.
- The embedding model is **`text-embedding-3-small`** (OpenAI's latest cost-efficient embedding model as of 2024).

### OpenAI usage (indexing)

| Aspect | Value |
|--------|-------|
| **Model** | `text-embedding-3-small` |
| **Input** | `request.content` (the message text) |
| **Output** | 1536-dimensional float vector |
| **API call** | `openai_client.embeddings.create(input=..., model="text-embedding-3-small")` |
| **Purpose** | Convert unstructured text into a searchable vector |

---

## Retrieval Pipeline: `GET /search`

### Step-by-step flow

1. **Request arrives** — The caller sends query parameters `q` (search query) and `conversationId` (filter scope).
2. **Empty collection short-circuit** — If the `"Message"` collection does not exist in Weaviate (no messages have been indexed yet), the endpoint returns `{"results": []}` immediately without calling OpenAI.
3. **Weaviate connection** — Connects to the local Weaviate instance.
4. **Embedding generation** — The query string `q` is sent to OpenAI's `text-embedding-3-small` model, producing a vector embedding of the same dimensionality as indexed messages.
5. **Similarity search** — Weaviate performs a `near_vector` (approximate nearest neighbor) search:
   - **Query vector**: The embedding of `q`
   - **Filter**: `conversationId` must equal the requested conversation
   - **Limit**: Top 5 most similar results
6. **Response** — Results are returned as a JSON array with each hit containing `messageId`, `conversationId`, `senderId`, and `content`.

### OpenAI usage (retrieval)

| Aspect | Value |
|--------|-------|
| **Model** | `text-embedding-3-small` |
| **Input** | `q` (the search query string) |
| **Output** | 1536-dimensional float vector |
| **API call** | `openai_client.embeddings.create(input=q, model="text-embedding-3-small")` |
| **Purpose** | Convert the search query into a vector for similarity matching |

---

## How OpenAI is used across both pipelines

The AI Agent uses **two separate OpenAI API capabilities** — embeddings and chat completions — for distinct purposes:

| Capability | Model | Endpoint(s) | Purpose |
|------------|-------|-------------|---------|
| **Embeddings** | `text-embedding-3-small` | `/index/message`, `/search` | Convert text to vectors for semantic search |
| **Chat Completions** | `gpt-4o-mini` | `/chat`, `/transfers/analyse`, `/proposals/summarise` | Generate conversational replies and structured analysis |

These are **independent systems**. The embedding model is never used for chat, and the chat model is never used for search. They share the same `OPENAI_API_KEY` environment variable but serve different architectural roles.

---

## How the pipeline is consumed by callers

### Current integration status

**The retrieval pipeline (`/search`) is NOT currently integrated into any other endpoint's LLM prompt.**

As of the current codebase:

- `/chat` — Uses only the `gpt-4o-mini` chat model with a system prompt about Clicked. It does **not** call `/search` to retrieve relevant messages for RAG context injection.
- `/transfers/analyse` — Uses the chat model for fraud risk analysis of a single transfer. No message retrieval.
- `/proposals/summarise` — Uses the chat model to summarise governance proposals. No message retrieval.

The `/search` endpoint and the indexing pipeline exist as **standalone infrastructure**. They are available for future integration — for example, a chat endpoint could retrieve relevant past messages via `/search` and inject them as context into the LLM prompt — but this integration has not yet been implemented.

### How callers SHOULD consume the pipeline (future integration path)

The intended consumption pattern is:

1. **Index messages as they arrive** — Call `POST /index/message` when a new message is sent or edited
2. **Retrieve context before LLM calls** — When processing a chat query, call `GET /search?q=<user query>&conversationId=<conv>` to find semantically similar past messages
3. **Inject results into the prompt** — Include the top search results as additional context in the chat completion prompt

This pattern enables the AI Agent to provide answers informed by conversation history without requiring the entire conversation to fit in the LLM context window.

---

## Privacy and data scope

### Conversation isolation

The search endpoint filters by `conversationId` using Weaviate's property filter:

```python
filters=Filter.by_property("conversationId").equal(conversationId)
```

This ensures that a search in conversation A never returns results from conversation B. Privacy is enforced at the database query level, not the application level.

### Embedding data flow

- Message content is sent to OpenAI's API for embedding generation
- The embedding vector is stored in Weaviate alongside the message
- The original message text is also stored as a property (not just the vector), enabling the search response to include readable content
- There is no mechanism to delete embeddings selectively — the upsert pattern allows replacement (for edited messages) but not deletion

---

## Error handling

| Scenario | `/index/message` behavior | `/search` behavior |
|----------|--------------------------|-------------------|
| Weaviate unavailable | Returns HTTP 503 `"Weaviate connection failed"` | Returns HTTP 503 `"Weaviate connection failed"` |
| OpenAI API key missing | Returns HTTP 500 `"OPENAI_API_KEY is not configured"` | Returns HTTP 500 `"OPENAI_API_KEY is not configured"` |
| No messages indexed yet | N/A (first index creates the collection) | Returns HTTP 200 with `{"results": []}` |
| Invalid request body | FastAPI returns HTTP 422 with validation errors | FastAPI returns HTTP 422 if query params are missing |

---

## Dependencies

| Dependency | Version | Role |
|------------|---------|------|
| `fastapi` | >=0.135.1 | HTTP API framework |
| `openai` | >=1.0.0 | Embedding generation + chat completions |
| `weaviate-client` | >=4.0.0 | Vector database client |
| `uvicorn` | >=0.42.0 | ASGI server |
