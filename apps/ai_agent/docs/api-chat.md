# API Documentation: `POST /chat`

The `POST /chat` endpoint provides an interactive chat interface powered by OpenAI's language models. It handles user questions about Clicked platform features, Stellar token payments, group treasury management, and DAO governance.

---

## Endpoint Specification

- **HTTP Method**: `POST`
- **Path**: `/chat`
- **Content-Type**: `application/json`

---

## Request & Response Schemas

### Request: `ChatRequest`

Sourced from `ChatRequest` Pydantic model in `main.py`:

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | Yes | The user's input query or message prompt. |
| `conversation_id` | `string` | Yes | Unique identifier for tracking the chat thread or session context. |

#### JSON Schema Example:
```json
{
  "message": "What is Clicked and how do payments work?",
  "conversation_id": "conv-10293"
}
```

---

### Response: `ChatResponse`

Sourced from `ChatResponse` Pydantic model in `main.py`:

| Field | Type | Description |
|---|---|---|
| `reply` | `string` | The AI assistant's generated response message. |

#### JSON Schema Example:
```json
{
  "reply": "Clicked is a decentralised messaging and payment platform built on the Stellar blockchain. You can send XLM token payments directly inside chat threads."
}
```

---

## Model & System Prompt Configuration

- **LLM Model**: `gpt-4o-mini`
- **Request Timeout**: `30` seconds
- **System Prompt**:
  ```text
  You are an AI assistant for Clicked, a decentralised messaging and payment platform built on the Stellar blockchain. Clicked lets users send token payments inside chat conversations, manage group treasuries, and participate in DAO-style governance. Help users with questions about transactions, wallet management, group finances, and platform features.
  ```

---

## Failure Modes & Error Handling

All failure modes and HTTP status codes match the application implementation in `main.py` and unit tests in `tests/test_chat.py`.

### 1. `422 Unprocessable Entity` — Request Validation Error
Triggered automatically by FastAPI when request payload fails Pydantic schema validation (e.g., missing required `message` or `conversation_id` field).

**Response Body Shape**:
```json
{
  "detail": [
    {
      "loc": ["body", "message"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ]
}
```

### 2. `500 Internal Server Error` — Missing API Key
Triggered when the `OPENAI_API_KEY` environment variable is not configured on the server.

**Response Body Shape**:
```json
{
  "detail": "OPENAI_API_KEY is not configured"
}
```

### 3. `500 Internal Server Error` — Missing Dependency
Triggered if the required `openai` Python package is not installed in the application runtime environment.

**Response Body Shape**:
```json
{
  "detail": "openai package is not installed"
}
```

### 4. Upstream OpenAI API Errors / Timeout
If upstream OpenAI services encounter connection failures or timeout beyond the 30-second window, an unhandled exception will result in a standard HTTP 500 error response.

---

## Worked Example

### Worked Request
```http
POST /chat HTTP/1.1
Host: localhost:8000
Content-Type: application/json

{
  "message": "How do I manage group finances on Clicked?",
  "conversation_id": "conv-9921"
}
```

### Worked Response
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "reply": "You can manage group finances by creating a group treasury within your conversation thread. Members can deposit funds, view collective balances, and submit governance proposals for spending approvals."
}
```
