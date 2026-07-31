# WebSocket Event Catalog & Usage Guide

> **Scope:** Every inbound and outbound WebSocket event currently handled by the
> dispatcher and socket layer in `apps/backend/src/socket/`,
> `apps/backend/src/services/`, and `apps/backend/src/index.ts`.

---

## Table of Contents

1. [Connection & Authentication](#connection--authentication)
2. [Envelope-Wrapper vs. Legacy-Raw-Emit](#envelope-wrapper-vs-legacy-raw-emit)
3. [Inbound Events (Client → Server)](#inbound-events-client--server)
   - [`send_message`](#send_message)
   - [`send_file_message`](#send_file_message)
   - [`edit_message`](#edit_message)
   - [`delete_message`](#delete_message)
   - [`message_read`](#message_read)
   - [`message_delivered`](#message_delivered)
   - [`message_history`](#message_history)
   - [`join_room`](#join_room)
   - [`create_conversation`](#create_conversation)
   - [`typing_start`](#typing_start)
   - [`typing_stop`](#typing_stop)
   - [`ask_assistant`](#ask_assistant)
   - [`resume`](#resume)
   - [`heartbeat`](#heartbeat)
4. [Outbound Events (Server → Client)](#outbound-events-server--client)
   - [`room_joined`](#room_joined)
   - [`new_message`](#new_message)
   - [`message_envelope`](#message_envelope)
   - [`message_ack`](#message_ack)
   - [`message_edited`](#message_edited)
   - [`message_deleted`](#message_deleted)
   - [`read_receipt`](#read_receipt)
   - [`delivery_receipt`](#delivery_receipt)
   - [`device_delivery_receipt`](#device_delivery_receipt)
   - [`message_fully_delivered`](#message_fully_delivered)
   - [`conversation_created`](#conversation_created)
   - [`user_online`](#user_online)
   - [`user_offline`](#user_offline)
   - [`presence_update`](#presence_update)
   - [`ephemeral_replay`](#ephemeral_replay)
   - [`resume_complete`](#resume_complete)
   - [`device_envelope`](#device_envelope)
   - [`error`](#error)
   - [`dispatch`](#dispatch-outbound)
   - [`dispatch_ack`](#dispatch_ack)
   - [`device_set_mismatch`](#device_set_mismatch)
   - [`rate_limited`](#rate_limited)
   - [`device_revoked`](#device_revoked)
   - [`payload_too_large`](#payload_too_large)
5. [Known Gaps & Registry Inconsistencies](#known-gaps--registry-inconsistencies)
6. [Implementation References](#implementation-references)

---

## Connection & Authentication

Clients connect to the WebSocket server via Socket.IO.

### Connection URL

```
ws://<host>:<port>/socket.io/?transport=websocket
```

Default port is **3001**.

### Auth Handshake

Include a signed JWT in the Socket.IO `auth` handshake payload. The JWT is
obtained from the REST auth flow (`POST /auth/verify`).

```js
const socket = io('http://localhost:3001', {
  transports: ['websocket'],
  auth: {
    token: '<jwt-from-auth-verify>',
  },
});
```

On connect, the `socketAuthMiddleware` verifies the token, confirms the
referenced device exists and has not been revoked, and binds `socket.auth`
(with `userId`, `deviceId`, and `walletAddress`) to the socket for the entire
session lifetime.

### Auto-Join Behaviour

After authentication the server automatically:

1. Joins the socket to a per-device room (`device:<deviceId>`) for targeted
   envelope delivery.
2. Joins the socket to the per-user room for cross-device synchronization.
3. Joins the socket to every conversation room the user is a member of, so it
   receives `new_message` and presence events without a separate `join_room` call.

### Heartbeat

The server starts a 90-second heartbeat watchdog on connect. Clients **must**
emit a `heartbeat` event at least once every 90 seconds (recommended: every
30 seconds). If the timeout fires, the server marks the device offline and
disconnects the socket.

```js
setInterval(() => {
  socket.emit('heartbeat');
}, 30_000);
```

---

## Envelope-Wrapper vs. Legacy-Raw-Emit

The backend supports **two** event-emission styles concurrently. Both are
functional today, but **new client code should use the envelope wrapper**.

### Standard Envelope (recommended)

Clients emit a single `dispatch` event with a structured envelope. The envelope
carries the real event type inside `type` and the actual payload inside
`payload`. The dispatcher validates the envelope, runs an idempotency check on
`eventId` (Redis-backed, 24-hour TTL), and routes to the correct handler.

```js
// Emit a send_message event via the envelope wrapper
socket.emit('dispatch', {
  eventId: crypto.randomUUID(), // unique per emission; used for dedup
  type: 'send_message', // the actual event type
  timestamp: Date.now(), // millisecond epoch
  payload: {
    // event-specific payload
    conversationId: 'abc-123',
    messageId: 'msg-456',
    contentType: 'text',
    ciphertext: '<encrypted-base64>',
    envelopes: [
      {
        recipientDeviceId: 'dev-001',
        ciphertext: '<per-device-ciphertext>',
      },
    ],
  },
});
```

**Supported envelope events** — the dispatcher validates `type` against a
central registry (`KNOWN_EVENT_TYPES` in `apps/backend/src/lib/eventEnvelope.ts`).
Unrecognized types are rejected with an `error` event.

The following inbound event types are supported through the envelope wrapper
(i.e., they pass `isKnownEventType()` in `KNOWN_EVENT_TYPES`):

- `join_room`
- `send_message`
- `message_history`
- `delete_message`
- `message_read`
- `create_conversation`
- `typing_start`
- `typing_stop`
- `ask_assistant`
- `resume`
- `join_device_channel` _(in KNOWN_EVENT_TYPES but has no registered handler —
  accepted by the envelope validator then silently dropped)_

> **Important:** `edit_message`, `message_delivered`, and `send_file_message`
> are **NOT** in `KNOWN_EVENT_TYPES`. They are only reachable via legacy raw
> emit — the envelope dispatcher will reject them with "Unknown event type."
> This is a known gap in the registry.

### Legacy Raw Emit (backward-compatible)

Clients can also emit Socket.IO events directly, without the envelope wrapper.
Each call to `dispatcher.register(type, handler)` also attaches a raw
`socket.on(type, …)` listener so existing clients that emit bare events
continue to work.

```js
// Legacy raw emit — still works, but no idempotency or validation
socket.emit('send_message', {
  conversationId: 'abc-123',
  messageId: 'msg-456',
  contentType: 'text',
  ciphertext: '<encrypted-base64>',
  envelopes: [{ recipientDeviceId: 'dev-001', ciphertext: '<per-device-ciphertext>' }],
});
```

> **Note:** The `send_file_message` event is currently **only** available via
> legacy raw emit (`socket.on('send_file_message', …)` — no dispatcher
> registration). It does not pass through the envelope validator or
> idempotency check, meaning: no `eventId` dedup, no `dispatch_ack` response,
> and no Zod schema validation on the envelope shape. This is a known gap
> tracked for future alignment.

### Outbound Envelopes

Outbound events from the server also use the envelope format. When the server
emits via `dispatcher.emit(type, payload)`, it produces:

```json
{
  "eventId": "<uuid>",
  "type": "error",
  "timestamp": 1720000000000,
  "payload": { "message": "Something went wrong" }
}
```

These are emitted on the `dispatch` Socket.IO event. Many outbound events
(e.g., `new_message`, `presence_update`) still use the raw emit style directly
for performance — they bypass the envelope wrapper entirely.

---

## Inbound Events (Client → Server)

---

### `send_message`

Send an encrypted text message to a conversation.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "contentType": "text",
  "ciphertext": "<base64-encrypted-body>",
  "envelopes": [
    {
      "recipientDeviceId": "uuid",
      "ciphertext": "<base64-per-device-ciphertext>"
    }
  ],
  "fileId": "uuid | undefined"
}
```

| Field            | Type          | Required                  | Notes                                                                                                                                                                   |
| ---------------- | ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes                       | Target conversation.                                                                                                                                                    |
| `messageId`      | string (UUID) | Yes                       | Client-generated id. Idempotent — duplicate `messageId` returns `message_ack` without re-insert.                                                                        |
| `contentType`    | string        | No (defaults to `"text"`) | `text` for regular messages; `image`, `video`, `audio`, `file` for attachments.                                                                                         |
| `ciphertext`     | string        | Yes                       | AES-encrypted message body. Falls back to `content` for legacy clients.                                                                                                 |
| `envelopes`      | array         | See note                  | One per-device ciphertext entry per active recipient device **including the sender's sibling devices** (Issue #188). Required when the sender has more than one device. |
| `fileId`         | string        | No                        | Pre-uploaded file id for attachment messages.                                                                                                                           |

**When it fires:** Client emits to send a new message.

**Server-side flow:**

1. Clears any active `typing_start` state for the sender.
2. Validates the payload (content, envelopes, fileId).
3. Enforces sibling-device coverage — if the sender has multiple devices, every sibling must have an envelope entry.
4. Inserts the message and per-device envelopes in a transaction.
5. Calls `deliverMessage()` to push per-device envelopes and `new_message` notifications.
6. Invalidates conversation caches and dispatches offline push notifications.

**Responses:**

- `message_ack` on success (to the sender).
- `error` on validation failure, non-membership, or device set mismatch.
- `device_set_mismatch` when sibling device envelope coverage is incomplete.

---

### `send_file_message`

Send an encrypted file/image/video/audio message. **Legacy-only** (not
available through the envelope wrapper).

**Availability:** Legacy raw emit only.

**Payload:**

```json
{
  "conversationId": "uuid",
  "fileId": "uuid",
  "content": "<base64-encrypted-metadata>",
  "contentType": "image"
}
```

| Field            | Type          | Required | Notes                                                       |
| ---------------- | ------------- | -------- | ----------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes      | Target conversation.                                        |
| `fileId`         | string (UUID) | Yes      | Must reference a pre-uploaded file with `status = "ready"`. |
| `content`        | string        | Yes      | Encrypted file metadata ciphertext. Must be non-empty.      |
| `contentType`    | string        | Yes      | One of: `file`, `image`, `video`, `audio`.                  |

**When it fires:** Client emits after uploading and encrypting a file via
`POST /files/upload`.

**Server-side flow:**

1. Validates content type and file ownership (uploader must be sender, file
   must belong to the conversation, status must be `ready`).
2. Inserts the message row.
3. Emits `new_message` to the conversation room.
4. Invalidates caches and dispatches push notifications.

---

### `edit_message`

Edit a previously sent message. The edit is stored as a new message row that
references the original via `editsMessageId`.

**Availability:** Legacy raw emit only.

> **Note:** `edit_message` is NOT in `KNOWN_EVENT_TYPES`. The envelope
> dispatcher (`dispatch` event) will reject it. Use raw `socket.emit('edit_message', …)`.

**Payload:**

```json
{
  "originalMessageId": "uuid",
  "messageId": "uuid",
  "contentType": "text",
  "ciphertext": "<base64-encrypted-edited-body>",
  "envelopes": [
    {
      "recipientDeviceId": "uuid",
      "ciphertext": "<base64-per-device-ciphertext>"
    }
  ]
}
```

| Field               | Type          | Required           | Notes                                               |
| ------------------- | ------------- | ------------------ | --------------------------------------------------- |
| `originalMessageId` | string (UUID) | Yes                | The id of the message being edited.                 |
| `messageId`         | string (UUID) | Yes                | Client-generated id for the edit row. Idempotent.   |
| `contentType`       | string        | No                 | Inherits original message's contentType if omitted. |
| `ciphertext`        | string        | Yes                | Encrypted new body. Must be non-empty.              |
| `envelopes`         | array         | See `send_message` | Same sibling-device coverage requirement.           |

**When it fires:** Client emits to replace the content of an existing message.

**Responses:**

- `message_ack` on success (to the editor).
- `message_edited` broadcast to the conversation room with `{originalMessageId, newMessageId}`.
- `error` if the original message doesn't exist or the editor is not the original sender.

---

### `delete_message`

Soft-delete a message (sets `deletedAt`, nulls `ciphertext`, deletes
associated envelopes and optionally the attached file).

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "messageId": "uuid"
}
```

| Field       | Type          | Required | Notes                                                             |
| ----------- | ------------- | -------- | ----------------------------------------------------------------- |
| `messageId` | string (UUID) | Yes      | Message to delete. Sender-only — must match `socket.auth.userId`. |

**When it fires:** Client emits to remove a message.

**Responses:**

- `message_deleted` broadcast to the conversation room with `{messageId}`.
- `error` if the message is not found or the requester is not the sender.

---

### `message_read`

Mark a conversation as read up to a specific message. Updates
`conversationMembers.lastReadMessageId`.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "lastReadMessageId": "uuid"
}
```

| Field               | Type          | Required | Notes                                                       |
| ------------------- | ------------- | -------- | ----------------------------------------------------------- |
| `conversationId`    | string (UUID) | Yes      |                                                             |
| `lastReadMessageId` | string (UUID) | Yes      | Must be a message that actually exists in the conversation. |

**When it fires:** Client emits when the user reads messages (e.g., opens a
conversation, scrolls to the bottom).

**Responses:**

- `read_receipt` broadcast (volatile) to the conversation room with
  `{conversationId, userId, lastReadMessageId}`.
- The receipt is also written to the per-user Redis resume stream so
  disconnected sibling devices can replay it.

---

### `message_delivered`

Per-device delivery receipt. Tells the server that a specific device has
received and processed a message envelope.

**Availability:** Legacy raw emit only.

> **Note:** `message_delivered` is NOT in `KNOWN_EVENT_TYPES`. The envelope
> dispatcher (`dispatch` event) will reject it. Use raw `socket.emit('message_delivered', …)`.

**Payload:**

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "envelopeId": "uuid",
  "sequenceNumber": 42
}
```

| Field            | Type          | Required | Notes                                                    |
| ---------------- | ------------- | -------- | -------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes      |                                                          |
| `messageId`      | string (UUID) | Yes      | Message whose envelope was delivered.                    |
| `envelopeId`     | string (UUID) | No       | Specific envelope that was delivered.                    |
| `sequenceNumber` | number        | No       | Per-conversation monotonic sequence number for ordering. |

**When it fires:** Client emits after decrypting and processing a
`message_envelope`.

**Server-side flow:**

1. Calls `handleDeviceDeliveryReceipt()` which updates `deliveredAt` on the
   matching `messageEnvelopes` row (idempotent).
2. If all active devices for that recipient have now delivered, emits
   `message_fully_delivered` to the sender.
3. Broadcasts `device_delivery_receipt` (volatile) to the conversation room.
4. Writes the receipt to the per-user resume stream.

---

### `message_history`

Request paginated message history for a conversation (newest first, 30 per
page).

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "before": "uuid | undefined"
}
```

| Field            | Type          | Required | Notes                                                                         |
| ---------------- | ------------- | -------- | ----------------------------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes      |                                                                               |
| `before`         | string (UUID) | No       | Cursor — exclude this message and everything newer. Omit for the latest page. |

**When it fires:** Client emits when opening a conversation or scrolling up
to load older messages.

**Responses:**

- `message_history` with `{conversationId, messages: [...]}` — each message is
  serialised via `serializeMessage()` and includes sender info, device info,
  and envelope ciphertexts.
- `error` if the requester is not a conversation member.

---

### `join_room`

Explicitly join a conversation's Socket.IO room. (Note: on connect the server
already auto-joins rooms for all the user's memberships, so this event is
mostly useful after a new membership is created.)

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid"
}
```

| Field            | Type          | Required | Notes                                           |
| ---------------- | ------------- | -------- | ----------------------------------------------- |
| `conversationId` | string (UUID) | Yes      | Must be a conversation the user is a member of. |

**When it fires:** Client emits to subscribe to real-time events for a
specific conversation.

**Responses:**

- `room_joined` with `{conversationId}`.
- `error` if the user is not a member.

---

### `create_conversation`

Create a new DM or group conversation and add members.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "type": "group",
  "name": "Project Alpha",
  "memberIds": ["uuid-1", "uuid-2"]
}
```

| Field       | Type     | Required | Notes                                                                             |
| ----------- | -------- | -------- | --------------------------------------------------------------------------------- |
| `type`      | string   | Yes      | `"dm"` or `"group"`.                                                              |
| `name`      | string   | No       | Display name (recommended for groups).                                            |
| `memberIds` | string[] | Yes      | Other member user ids. The creator (`socket.auth.userId`) is added automatically. |

**When it fires:** Client emits when the user creates a new conversation.

**Responses:**

- `conversation_created` with the full conversation row.
- `error` if creation fails.

---

### `typing_start`

Signal that the user started typing in a conversation.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "deviceId": "uuid | undefined"
}
```

| Field            | Type          | Required | Notes                                                             |
| ---------------- | ------------- | -------- | ----------------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes      |                                                                   |
| `deviceId`       | string (UUID) | No       | Sender's device id. If omitted, typing is attributed to the user. |

**When it fires:** Client emits on the first keystroke in a conversation
(after an idle period).

**Server-side flow:**

1. Verifies membership (allows non-room-joined members too).
2. Starts a 5-second auto-stop timer per `(conversationId, deviceId)`.
3. Relays `typing_start` to other members in the conversation room.

---

### `typing_stop`

Signal that the user stopped typing in a conversation.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "deviceId": "uuid | undefined"
}
```

| Field            | Type          | Required | Notes                                           |
| ---------------- | ------------- | -------- | ----------------------------------------------- |
| `conversationId` | string (UUID) | Yes      |                                                 |
| `deviceId`       | string (UUID) | No       | If provided, only stops typing for that device. |

**When it fires:** Client emits when the input field is cleared or after a
debounce period with no keystrokes.

**Server-side flow:**

1. Clears the auto-stop timer.
2. Relays `typing_stop` to other members in the conversation room.

---

### `ask_assistant`

Ask the AI assistant a question. The message must start with `@assistant`.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "conversationId": "uuid",
  "content": "@assistant What is the current balance of our group treasury?"
}
```

| Field            | Type          | Required | Notes                                                                     |
| ---------------- | ------------- | -------- | ------------------------------------------------------------------------- |
| `conversationId` | string (UUID) | Yes      |                                                                           |
| `content`        | string        | Yes      | Must start with `@assistant`. The full text is forwarded to the AI agent. |

**When it fires:** Client emits when a user sends a message starting with
`@assistant`.

**Server-side flow:**

1. Validates membership and the `@assistant` prefix.
2. Applies a rate limit: max 5 `ask_assistant` events per user per 60 seconds
   (Redis-backed sliding window). Exceeding emits `rate_limited`.
3. Makes an HTTP POST to the AI agent service at `http://localhost:8000/chat`:

   ```json
   { "message": "@assistant What is the current balance...", "conversation_id": "uuid" }
   ```

4. The AI agent service (`apps/ai_agent/main.py`) is a **Python FastAPI**
   server running on port 8000. It:
   - Receives the request at `POST /chat` as a `ChatRequest`.
   - Calls OpenAI's `gpt-4o-mini` model through the `openai` Python SDK
     (requires `OPENAI_API_KEY` env var).
   - Uses a system prompt contextualising the assistant as a Clicked platform
     expert (messaging, Stellar payments, group treasuries, DAO governance).
   - Returns `{"reply": "<assistant response text>"}` with a 30-second timeout.
5. On success, the backend:
   - Upserts a special "Assistant" user row (id: `00000000-0000-4000-8000-000000000000`).
   - Ensures the Assistant user is a member of the conversation.
   - Inserts a new message row with the assistant's reply as `ciphertext`
     (plaintext — not actually encrypted).
   - Emits `new_message` to the conversation room (volatile).
   - Invalidates member caches.
6. On failure, emits `error` with `"Failed to get AI reply"`.

**AI agent service other endpoints (for context):**

| Endpoint               | Method | Purpose                                                                        |
| ---------------------- | ------ | ------------------------------------------------------------------------------ |
| `/health`              | GET    | Health check.                                                                  |
| `/chat`                | POST   | Main assistant chat (used by `ask_assistant`).                                 |
| `/transfers/analyse`   | POST   | Fraud analysis for Stellar transfers (rule-based for >10k XLM, LLM otherwise). |
| `/proposals/summarise` | POST   | Summarise a governance proposal and assess risk level.                         |
| `/index/message`       | POST   | Index a message into Weaviate vector DB for semantic search.                   |
| `/search`              | GET    | Semantic search over indexed messages using Weaviate.                          |

> The `/transfers/analyse`, `/proposals/summarise`, `/index/message`, and
> `/search` endpoints are not directly triggered by the `ask_assistant`
> handler today. They are available for future integration or direct REST
> calls.

---

### `resume`

Replay missed ephemeral events after a disconnect. The client sends its last
known `lastEventId` and the server replays everything recorded to the user's
Redis resume stream after that cursor.

**Availability:** Envelope wrapper + legacy raw emit.

**Payload:**

```json
{
  "lastEventId": "1719000000000-0"
}
```

| Field         | Type   | Required | Notes                                                                                              |
| ------------- | ------ | -------- | -------------------------------------------------------------------------------------------------- |
| `lastEventId` | string | Yes      | Redis stream id of the last event the client saw. Empty string to replay the full retained window. |

**When it fires:** Client emits immediately after reconnecting (before
running a full sync).

**Server-side flow:**

1. Reads the user's Redis resume stream (`resume:events:<userId>`) with an
   exclusive range from `(lastEventId` to `+`.
2. For each missed event, emits `ephemeral_replay` with `{id, type, data}`.
3. Emits `resume_complete` with `{lastEventId: <new-cursor>, syncRequired: true}`.
4. If Redis is unavailable, emits `resume_complete` with `syncRequired: true`
   and no cursor, so the client falls back to a full sync.

**Which events are replayed:** Only non-durable, ephemeral events:

- `read_receipt`
- `delivery_receipt`
- `device_delivery_receipt`
- `message_fully_delivered`
- `presence_update`
- Future: system notices, typing indicators (currently not persisted).

Durable chat messages are deliberately **not** in the resume stream — clients
must recover them via the `/sync` REST endpoint or `message_history`.

---

### `heartbeat`

Keep the WebSocket connection alive. The server starts a 90-second watchdog
on connect; clients must emit `heartbeat` within that window to stay
connected.

**Availability:** Legacy raw emit only (excluded from dispatcher middleware).

**Payload:** None (empty event).

**When it fires:** Client emits on a timer (recommended every 30 seconds).

**Server-side flow:**

1. Resets the 90-second disconnect timer.
2. Refreshes presence TTLs in Redis.
3. Throttles `devices.lastSeenAt` DB update to once per 30 seconds.

---

## Outbound Events (Server → Client)

---

### `room_joined`

Confirmation after a client successfully joins a conversation room via
`join_room`.

**Payload:**

```json
{
  "conversationId": "uuid"
}
```

**When it fires:** Immediately after `join_room` membership validation succeeds.

---

### `new_message`

Notification that a new message exists in a conversation. **Ciphertext is
intentionally omitted** — each device receives its encrypted payload via
`message_envelope` separately.

**Payload:**

```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "senderDeviceId": "uuid",
  "contentType": "text",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "deletedAt": null,
  "ciphertext": null
}
```

**When it fires:**

- After `send_message` or `send_file_message` persists and delivers the message.
- Emitted to both the raw conversation room and the optimized conversation room
  (via `conversationRoom()`).
- Also emitted by `ask_assistant` for the AI reply (volatile).

---

### `message_envelope`

Per-device encrypted envelope. Contains the ciphertext that only the target
device can decrypt.

**Payload:**

```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "senderDeviceId": "uuid",
  "contentType": "text",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "envelopeId": "uuid",
  "ciphertext": "<base64-encrypted-per-device>"
}
```

**When it fires:** During `deliverMessage()`, one per active recipient device
(excluding the sender's own device). Emitted to each device's scoped room
(`device:<deviceId>`).

---

### `message_ack`

Acknowledgment that a message was successfully persisted.

**Payload:**

```json
{
  "messageId": "uuid",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:**

- After the message row is inserted in the database (successful
  `send_message`).
- For idempotent re-delivery, when the same `messageId` already exists.
- For `edit_message` after the edit row is inserted.
- Emitted only to the sending socket.

---

### `message_edited`

Notification that a message was edited. Other clients use this to update
their UI and fetch the latest edit.

**Payload:**

```json
{
  "originalMessageId": "uuid",
  "newMessageId": "uuid"
}
```

**When it fires:** After a successful `edit_message`, broadcast to the
conversation room.

---

### `message_deleted`

Notification that a message was soft-deleted.

**Payload:**

```json
{
  "messageId": "uuid"
}
```

**When it fires:** After a successful `delete_message`, broadcast to both the
raw conversation room and the optimized conversation room.

---

### `read_receipt`

Indicates a user has read up to a specific message in a conversation.

**Payload:**

```json
{
  "conversationId": "uuid",
  "userId": "uuid",
  "lastReadMessageId": "uuid"
}
```

**When it fires:**

- After a successful `message_read`, broadcast to the conversation room
  (volatile).
- Also written to the per-user resume stream so disconnected devices can
  replay it during `resume`.

---

### `delivery_receipt`

Indicates a message envelope was delivered to a specific device.

**Payload:**

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "envelopeId": "uuid",
  "userId": "uuid",
  "deviceId": "uuid",
  "sequenceNumber": 42,
  "deliveredAt": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:** After `message_delivered` is processed, broadcast to the
conversation room (volatile) and written to the resume stream.

---

### `device_delivery_receipt`

Per-device delivery confirmation. Similar to `delivery_receipt` but keyed by
recipient device, emitted via the optimized conversation room.

**Payload:**

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "envelopeId": "uuid",
  "recipientUserId": "uuid",
  "recipientDeviceId": "uuid",
  "sequenceNumber": 42,
  "deliveredAt": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:**

- From `message_delivered` handler, broadcast to the optimized conversation
  room (volatile).
- From `handleDeviceDeliveryReceipt()`, after updating `deliveredAt`.
- Written to the resume stream for replay.

---

### `message_fully_delivered`

Indicates that **all** active devices of a recipient user have received a
particular message.

**Payload:**

```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "recipientUserId": "uuid",
  "deliveredAt": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:** After `handleDeviceDeliveryReceipt()` determines that
every active, non-revoked device for the recipient has a `deliveredAt`
timestamp. Emitted to the sender's user room and written to the sender's
resume stream.

---

### `conversation_created`

Confirmation that a new conversation was created.

**Payload:**

```json
{
  "id": "uuid",
  "type": "group",
  "name": "Project Alpha",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:** After `create_conversation` inserts the conversation and
member rows. Emitted only to the creating socket.

---

### `user_online`

Notification that a user came online.

**Payload:**

```json
{
  "userId": "uuid"
}
```

**When it fires:** On socket connect, when `setOnline()` indicates the user
transitioned from offline to online (i.e., this is their first active device).
Broadcast to all conversation rooms the user is a member of. Respects the
user's `presenceVisible` flag.

---

### `user_offline`

Notification that a user went fully offline (no remaining active devices).

**Payload:**

```json
{
  "userId": "uuid"
}
```

**When it fires:** On socket disconnect, when `setOffline()` confirms no
remaining active device entries exist for the user. Suppressed during gateway
shutdowns. Broadcast to all conversation rooms the user was a member of.
Respects `presenceVisible`.

---

### `presence_update`

Extended presence status update with online/offline state and optional
`lastSeen` timestamp.

**Payload:**

```json
{
  "userId": "uuid",
  "online": true,
  "status": "online",
  "lastSeen": 1720000000000
}
```

Or when offline:

```json
{
  "userId": "uuid",
  "online": false,
  "lastSeen": "2025-01-01T00:00:00.000Z"
}
```

**When it fires:**

- On connect (when user transitions to online): `{online: true, status: "online", lastSeen: <now>}`.
- On disconnect (when fully offline): `{online: false, lastSeen: "<ISO timestamp>"}`.
- Also written to the resume stream as `presence_update` events for replay.

---

### `ephemeral_replay`

Replayed ephemeral event during the resume protocol.

**Payload:**

```json
{
  "id": "1719000000001-0",
  "type": "read_receipt",
  "data": {
    "conversationId": "uuid",
    "userId": "uuid",
    "lastReadMessageId": "uuid"
  }
}
```

**When it fires:** During `resume`, one event per missed ephemeral event in
the Redis resume stream. The `id` is the Redis stream id — clients store this
as `lastEventId` for the next resume.

---

### `resume_complete`

Signals the end of the resume replay. The client should follow up with a full
sync (`GET /sync`) if `syncRequired` is `true`.

**Payload:**

```json
{
  "lastEventId": "1719000000050-0",
  "syncRequired": true
}
```

**When it fires:** After all missed ephemeral events have been replayed. The
`lastEventId` is the cursor of the last replayed event (or `null` if no events
were missed or Redis is unavailable).

---

### `device_envelope`

Cross-instance per-device envelope delivery. Used when the device is
connected to a different gateway instance than the one that published the
message.

**Payload:**

```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "ciphertext": "<base64-encrypted>"
}
```

**When it fires:** When `publishToDevice()` publishes to the Redis device
delivery channel and the `GatewayDeviceSubscriber` on the device's actual
gateway receives it. Emitted directly to the socket.

---

### `error`

Generic error notification.

**Payload:**

```json
{
  "event": "send_message",
  "message": "Not a member of this conversation",
  "code": "VALIDATION_ERROR"
}
```

| Field              | Type     | Notes                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `event`            | string   | The event that triggered the error.                                     |
| `message`          | string   | Human-readable description.                                             |
| `code`             | string   | Optional error code (e.g., `VALIDATION_ERROR`, `DEVICE_SET_MISMATCH`).  |
| `eventId`          | string   | The envelope eventId (when the error relates to a dispatched envelope). |
| `details`          | object   | Structured error details (e.g., Zod validation errors).                 |
| `missingDeviceIds` | string[] | For `device_set_mismatch`, the sibling device ids lacking envelopes.    |

**When it fires:** On any handler or middleware error — validation failures,
non-membership, rate limiting, payload size exceeded, device revocation,
unknown event types, malformed envelopes, AI agent failures, etc.

---

### `dispatch` (outbound)

Outbound envelope wrapper. When the server uses `dispatcher.emit(type,
payload)`, the event is emitted on the `dispatch` channel with the standard
envelope shape.

**Payload:**

```json
{
  "eventId": "uuid",
  "type": "error",
  "timestamp": 1720000000000,
  "payload": {
    "message": "Something went wrong"
  }
}
```

**When it fires:** When the `EventDispatcher` emits an event through the
envelope wrapper. Currently used primarily for `error` events from the
dispatcher itself.

---

### `dispatch_ack`

Acknowledgment for an envelope dispatched event. Confirms the event was
processed (or was a duplicate).

**Payload:**

```json
{
  "eventId": "uuid",
  "duplicate": false
}
```

| Field       | Type    | Notes                                                                   |
| ----------- | ------- | ----------------------------------------------------------------------- |
| `eventId`   | string  | Matches the envelope's `eventId`.                                       |
| `duplicate` | boolean | `true` if the event was skipped due to idempotency (already processed). |

**When it fires:** After the dispatcher processes an envelope event (success
or idempotent skip). Emitted only to the sending socket.

---

### `device_set_mismatch`

Indicates the client's device set is stale — the provided per-device envelopes
don't cover all required recipient devices.

**Payload:**

```json
{
  "event": "device_set_mismatch",
  "message": "Missing envelopes for 2 sibling device(s)",
  "missingDeviceIds": ["dev-uuid-1", "dev-uuid-2"]
}
```

**When it fires:** During `send_message` or `edit_message` when
`fetchSiblingDeviceIds()` finds sibling devices that are not covered by the
provided `envelopes` array (Issue #188).

---

### `rate_limited`

Indicates the client has exceeded the rate limit for an event.

**Payload:**

```json
{
  "event": "rate_limited",
  "message": "Rate limit exceeded"
}
```

**When it fires:**

- From the per-socket middleware when `checkRateLimit()` fails (default
  configurable via `SOCKET_RATE_LIMIT_PER_SEC`). After 3 violations the
  socket is disconnected.
- From `ask_assistant` when the per-user 5/minute limit is exceeded.

---

### `device_revoked`

Indicates the connected device has been revoked. The socket will be
disconnected immediately after this event.

**Payload:**

```json
{
  "message": "This device has been revoked"
}
```

**When it fires:** When the Redis pub/sub `device_revoked:<deviceId>` channel
receives a message, or when the per-socket middleware detects
`isDeviceRevoked()` is `true`. The socket is force-disconnected.

---

### `payload_too_large`

Indicates a client event payload exceeded the maximum allowed size.

**Payload:**

```json
{
  "event": "payload_too_large",
  "message": "Payload size 1048576 exceeds limit"
}
```

**When it fires:** From the per-socket middleware when `checkPayloadSize()`
fails. Configurable via `MAX_PAYLOAD_SIZE` env var.

---

## Known Gaps & Registry Inconsistencies

The central event registry (`KNOWN_EVENT_TYPES` in
`apps/backend/src/lib/eventEnvelope.ts`) does not cover all events currently
handled by the socket layer. This is a deliberate snapshot of the
envelope-wrapper migration in progress.

### Inbound events NOT in the registry (legacy raw emit only)

| Event               | Handler exists?                 | Notes                                             |
| ------------------- | ------------------------------- | ------------------------------------------------- |
| `edit_message`      | Yes (via `dispatcher.register`) | Envelope dispatch rejects it. Works via raw emit. |
| `message_delivered` | Yes (via `dispatcher.register`) | Envelope dispatch rejects it. Works via raw emit. |
| `send_file_message` | Yes (via `socket.on`)           | No dispatcher integration at all.                 |

### Outbound events NOT in the registry

These are emitted directly (`io.to(…).emit`, `socket.emit`, `socket.to(…).emit`)
without going through the envelope wrapper:

- `message_edited`
- `delivery_receipt`
- `device_delivery_receipt`
- `message_fully_delivered`
- `user_online`
- `user_offline`
- `presence_update`
- `dispatch_ack`
- `device_set_mismatch`
- `rate_limited`
- `device_revoked`
- `payload_too_large`
- `typing_start` (relayed)
- `typing_stop` (relayed)

### Registry entry with no handler

- `join_device_channel` — present in `KNOWN_EVENT_TYPES` (so envelope dispatch
  accepts it), but no handler is registered. The event is silently dropped.

## Implementation References

| File                                               | Purpose                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/socket/dispatcher.ts`            | `EventDispatcher` — envelope routing, validation, idempotency, backward-compat raw listeners.                  |
| `apps/backend/src/socket/messaging.ts`             | `registerMessagingHandlers()` — all messaging/presence/assistant event handlers.                               |
| `apps/backend/src/lib/eventEnvelope.ts`            | `KNOWN_EVENT_TYPES` registry, `EventEnvelopeSchema` (Zod), `createEnvelope()`.                                 |
| `apps/backend/src/middleware/socketAuth.ts`        | `socketAuthMiddleware` — JWT verification, device resolution, socket identity binding.                         |
| `apps/backend/src/index.ts`                        | Socket.IO server setup, connection lifecycle, auto-join, heartbeat, rate limiting, presence tracking.          |
| `apps/backend/src/services/deliveryPipeline.ts`    | `deliverMessage()` — per-device envelope fan-out and `new_message` broadcast.                                  |
| `apps/backend/src/services/deliveryAggregation.ts` | `handleDeviceDeliveryReceipt()` — per-device delivery tracking and `message_fully_delivered`.                  |
| `apps/backend/src/services/deviceDelivery.ts`      | `GatewayDeviceSubscriber` — cross-instance device envelope delivery via Redis.                                 |
| `apps/backend/src/services/resumeStream.ts`        | Resume protocol — Redis stream append, read, and replay for ephemeral events.                                  |
| `apps/backend/src/services/presence.ts`            | `setOnline`, `setOffline`, `deriveDevicePresence`, socket-mapping management.                                  |
| `apps/backend/src/services/heartbeat.ts`           | 90-second heartbeat watchdog with presence refresh.                                                            |
| `apps/backend/src/services/pushNotification.ts`    | `dispatchOfflinePush()` — Web Push for offline devices with coalescing and rate limiting.                      |
| `apps/backend/src/services/deviceRevocation.ts`    | `isDeviceRevoked()`, `startDeviceRevocationListener()` — cross-instance revocation.                            |
| `apps/backend/src/services/rateLimit.ts`           | `checkRateLimit()`, `checkPayloadSize()` — per-socket abuse prevention.                                        |
| `apps/backend/src/services/backpressure.ts`        | Socket buffer monitoring and overload shedding.                                                                |
| `apps/ai_agent/main.py`                            | AI agent FastAPI service — `/chat`, `/transfers/analyse`, `/proposals/summarise`, `/index/message`, `/search`. |
