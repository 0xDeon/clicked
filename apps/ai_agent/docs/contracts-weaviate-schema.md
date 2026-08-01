# Contracts Documentation: Weaviate Collection Schema

This document details the Weaviate vector database collection schema, embedding configurations, indexing procedures, and query filters utilized by the Clicked AI Agent service (`apps/ai_agent`).

---

## 1. Collection Specification

The service manages a single vector collection within Weaviate to store and index chat messages for semantic similarity search.

- **Collection Name**: `Message`
- **Class / Schema Target**: Local Weaviate instance (`weaviate.connect_to_local()`)

### Property Schema

Sourced directly from the collection indexing logic in `main.py` (`index_message` & `search_messages` functions):

| Property Name | Type | Description | Indexing & Filter Role |
|---|---|---|---|
| `messageId` | `string` (UUID) | Unique identifier for the message object. Serves as the primary Weaviate object UUID. | Object ID / Lookup |
| `conversationId` | `string` | ID of the conversation thread or chat room to which the message belongs. | **Filter Field** (`/search` scoping) |
| `senderId` | `string` | Stellar account or user ID of the sender. | Stored Property |
| `content` | `string` | Raw textual body content of the chat message. | Embedded Text Property |

---

## 2. Embedding & Vectorization Configuration

The vector embeddings for messages are generated externally using OpenAI's embedding API prior to insertion into Weaviate.

- **Embedding Provider**: OpenAI API
- **Embedding Model**: `text-embedding-3-small`
- **Vector Operations**:
  - **Indexing (`/index/message`)**: Generates vector via `openai_client.embeddings.create(input=request.content, model="text-embedding-3-small")` and attaches `vector=vector` directly during `insert` or `replace`.
  - **Search (`/search`)**: Embeds query `q` using `text-embedding-3-small` and executes a `near_vector` similarity query against Weaviate.

---

## 3. Query & Filtering Behavior (`/search`)

When searching indexed messages via `GET /search?q={query}&conversationId={conversationId}`, vector search results are strictly filtered to prevent cross-conversation data leaks.

### Search Criteria
- **Similarity Search**: `collection.query.near_vector(near_vector=vector, limit=5, filters=...)`
- **Primary Filter Field**: `conversationId`
- **Filter Constraint**: `Filter.by_property("conversationId").equal(conversationId)`
- **Result Limit**: Returns top `5` most relevant matching messages within the specified conversation thread.

---

## 4. First-Use & Auto-Creation Behavior

The service handles collection lifecycle and initial setup lazily upon API invocation:

1. **Indexing (`/index/message`)**:
   - Checks collection existence: `if not client.collections.exists("Message"):`
   - Auto-creates the collection if missing: `client.collections.create(name="Message")`
   - Upserts message data and vector embeddings seamlessly.

2. **Search (`/search`)**:
   - Checks collection existence: `if not client.collections.exists("Message"):`
   - If the `Message` collection has not been created yet, `/search` returns an empty payload (`{"results": []}`) without throwing an error.

3. **Connection Error Handling**:
   - If connection to the local Weaviate instance fails, the service returns a `503 Service Unavailable` status code with `{"detail": "Weaviate connection failed"}`.
