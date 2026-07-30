# Index & Search API Documentation

## 1. POST /index/message

### Description

The `/index/message` endpoint indexes a message into Weaviate for semantic search. It generates an embedding using
OpenAI (`text-embedding-3-small`) and stores it alongside the message metadata.

**What it does:**

- Connects to Weaviate vector database
- Creates the `Message` collection if it doesn't exist
- Generates an embedding vector from the message content
- Inserts or replaces the message based on `messageId` existence

### Request

| Field            | Type     | Required | Description                                   |
|------------------|----------|----------|-----------------------------------------------|
| `messageId`      | `string` | Yes      | Unique identifier for the message             |
| `conversationId` | `string` | Yes      | ID of the conversation the message belongs to |
| `senderId`       | `string` | Yes      | ID of the message sender                      |
| `content`        | `string` | Yes      | The message content to be indexed             |

### Example Request

```json
{
  "messageId": "msg_123456",
  "conversationId": "conv_789",
  "senderId": "user_456",
  "content": "Hello, how do I send XLM in Clicked?"
}
```

---

### Insert vs Replace Logic

The endpoint uses an **upsert** pattern based on the `messageId`:

| Scenario                                   | Behavior                                                                |
|--------------------------------------------|-------------------------------------------------------------------------|
| `messageId` **does not exist** in Weaviate | **Insert** a new record with the provided metadata and embedding vector |
| `messageId` **already exists** in Weaviate | **Replace** the existing record with new metadata and embedding vector  |

**Decision Logic:**

```python
if collection.data.exists(request.messageId):
    collection.data.replace(...)  # Update existing
else:
    collection.data.insert(...)   # Create new
```

**Why this matters:**
- Insert: Creates a new searchable entry for a new message
- Replace: Updates the embedding and content for edited messages
- Both actions keep the same messageId for consistent lookups

---

## Paso 6: Agregar Status Codes para /index/message

**Agrega esta sección:**

### Status Codes

| Status Code                 | Description                  | Response Example                                   |
|-----------------------------|------------------------------|----------------------------------------------------|
| `200 OK`                    | Message indexed successfully | `{ "status": "ok" }`                               |
| `503 Service Unavailable`   | Weaviate connection failed   | `{ "detail": "Weaviate connection failed" }`       |
| `500 Internal Server Error` | OpenAI API key missing       | `{ "detail": "OPENAI_API_KEY is not configured" }` |

### Error Response Example (503)

```json
{
  "detail": "Weaviate connection failed"
}
```

---

## 2. GET /search

### Description

The `/search` endpoint performs semantic search across indexed messages using vector similarity. It finds the most
relevant messages based on the query text, filtered by conversation.

**What it does:**

- Connects to Weaviate vector database
- Generates an embedding for the search query
- Performs a vector similarity search (nearest neighbor)
- Filters results by `conversationId`
- Returns top 5 most relevant messages

### Query Parameters

| Parameter        | Type     | Required | Description                               |
|------------------|----------|----------|-------------------------------------------|
| `q`              | `string` | Yes      | Search query text                         |
| `conversationId` | `string` | Yes      | Filter results to a specific conversation |

### Example Request

> GET /search?q=how%20to%20send%20XLM&conversationId=conv_789

### Filter Behavior

The search is filtered by `conversationId` to ensure users only see messages from the current conversation:

```python
filters=Filter.by_property("conversationId").equal(conversationId)
```

**Why this matters:**

- Prevents cross-conversation leakage
- Ensures privacy and relevance
- Reduces noise in search results

---

## Paso 8: Agregar Empty Collection Short-Circuit

**Agrega esta sección:**

### Empty Collection Short-Circuit

If the `Message` collection does not exist in Weaviate, the endpoint returns an empty result set without attempting to
search:

```python
if not client.collections.exists("Message"):
    return {"results": []}
```

**Why this matters:**

- Prevents errors when no messages have been indexed yet
- Returns a clean empty response instead of a 500 error
- Allows the frontend to handle empty states gracefully

Example Empty Response

```json
{
  "results": []
}
```

Success Response

```json
{
  "results": [
    {
      "messageId": "msg_123456",
      "conversationId": "conv_789",
      "senderId": "user_456",
      "content": "Hello, how do I send XLM in Clicked?"
    },
    {
      "messageId": "msg_123457",
      "conversationId": "conv_789",
      "senderId": "user_789",
      "content": "You can send XLM by clicking the send button in the chat."
    }
  ]
} 
```
# auiqe empeza otra vez sss-----------------------------------------



# Index & Search API Documentation

## 1. POST /index/message

### 1.1 Description

The `/index/message` endpoint indexes a message into Weaviate for semantic search. It generates an embedding using OpenAI (`text-embedding-3-small`) and stores it alongside the message metadata.

**What it does:**

- Connects to Weaviate vector database
- Creates the `Message` collection if it doesn't exist
- Generates an embedding vector from the message content
- Inserts or replaces the message based on `messageId` existence

---

### 1.2 Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | `string` | Yes | Unique identifier for the message |
| `conversationId` | `string` | Yes | ID of the conversation the message belongs to |
| `senderId` | `string` | Yes | ID of the message sender |
| `content` | `string` | Yes | The message content to be indexed |

---

### 1.3 Request Example

> ```json
> {
>   "messageId": "msg_123456",
>   "conversationId": "conv_789",
>   "senderId": "user_456",
>   "content": "Hello, how do I send XLM in Clicked?"
> }
> ```

---

### 1.4 Insert vs Replace Logic

The endpoint uses an **upsert** pattern based on the `messageId`:

| Scenario | Behavior |
|----------|----------|
| `messageId` **does not exist** in Weaviate | **Insert** a new record with the provided metadata and embedding vector |
| `messageId` **already exists** in Weaviate | **Replace** the existing record with new metadata and embedding vector |

**Decision Logic:**

> ```python
> if collection.data.exists(request.messageId):
>     collection.data.replace(...)  # Update existing
> else:
>     collection.data.insert(...)   # Create new
> ```

**Why this matters:**

- **Insert**: Creates a new searchable entry for a new message
- **Replace**: Updates the embedding and content for edited messages
- Both actions keep the same `messageId` for consistent lookups

---

### 1.5 Status Codes

| Status Code | Description | Response Example |
|-------------|-------------|------------------|
| `200 OK` | Message indexed successfully | `{ "status": "ok" }` |
| `503 Service Unavailable` | Weaviate connection failed | `{ "detail": "Weaviate connection failed" }` |
| `500 Internal Server Error` | OpenAI API key missing | `{ "detail": "OPENAI_API_KEY is not configured" }` |

**Error Response Example (503):**

> ```json
> {
>   "detail": "Weaviate connection failed"
> }
> ```

---

## 2. GET /search

### 2.1 Description

The `/search` endpoint performs semantic search across indexed messages using vector similarity. It finds the most relevant messages based on the query text, filtered by conversation.

**What it does:**

- Connects to Weaviate vector database
- Generates an embedding for the search query
- Performs a vector similarity search (nearest neighbor)
- Filters results by `conversationId`
- Returns top 5 most relevant messages

---

### 2.2 Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | `string` | Yes | Search query text |
| `conversationId` | `string` | Yes | Filter results to a specific conversation |

---

### 2.3 Example Request

> ```
> GET /search?q=how%20to%20send%20XLM&conversationId=conv_789
> ```

---

### 2.4 Filter Behavior

The search is filtered by `conversationId` to ensure users only see messages from the current conversation:

> ```python
> filters = Filter.by_property("conversationId").equal(conversationId)
> ```

**Why this matters:**

- Prevents cross-conversation leakage
- Ensures privacy and relevance
- Reduces noise in search results

---

### 2.5 Empty Collection Short-Circuit

If the `Message` collection does not exist in Weaviate, the endpoint returns an empty result set without attempting to search:

> ```python
> if not client.collections.exists("Message"):
>     return {"results": []}
> ```

**Why this matters:**

- Prevents errors when no messages have been indexed yet
- Returns a clean empty response instead of a 500 error
- Allows the frontend to handle empty states gracefully

---

### 2.6 Status Codes

| Status Code | Description | Response Example |
|-------------|-------------|------------------|
| `200 OK` | Search completed successfully | `{ "results": [...] }` |
| `503 Service Unavailable` | Weaviate connection failed | `{ "detail": "Weaviate connection failed" }` |
| `500 Internal Server Error` | OpenAI API key missing | `{ "detail": "OPENAI_API_KEY is not configured" }` |

---

### 2.7 Response Examples

**Empty Response (no messages indexed):**

> ```json
> {
>   "results": []
> }
> ```

**Success Response (with results):**

> ```json
> {
>   "results": [
>     {
>       "messageId": "msg_123456",
>       "conversationId": "conv_789",
>       "senderId": "user_456",
>       "content": "Hello, how do I send XLM in Clicked?"
>     },
>     {
>       "messageId": "msg_123457",
>       "conversationId": "conv_789",
>       "senderId": "user_789",
>       "content": "You can send XLM by clicking the send button in the chat."
>     }
>   ]
> }
> ```

---

## 3. Common Error Responses

### 3.1 503 Service Unavailable

This error occurs when the Weaviate connection fails for either endpoint.

**Error Response:**

> ```json
> {
>   "detail": "Weaviate connection failed"
> }
> ```

### 3.2 500 Internal Server Error

This error occurs when the OpenAI API key is not configured.

**Error Response:**

> ```json
> {
>   "detail": "OPENAI_API_KEY is not configured"
> }
> ```

