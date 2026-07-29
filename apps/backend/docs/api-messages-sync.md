# API docs: Messages & offline sync endpoints

This document describes the REST message operations and the offline envelope
backfill (`/sync`) endpoint implemented in `routes/messages.ts` and
`routes/sync.ts`.

It covers:

1. Sending a message via REST (`POST /messages`)
2. Deleting a message (`DELETE /messages/:id`)
3. Offline envelope sync (`GET /sync`) — cursor-based pagination, opaque cursor
   format, and TTL retention window

## Scope

All three routes require authentication (the `Authorization: Bearer <jwt>`
header). The JWT is obtained from `POST /auth/verify` and embeds `userId` and
`deviceId` in its payload.

The messaging endpoints in this document are the **REST** send/delete paths. A
parallel WebSocket send path exists in `socket/messaging.ts`; both share the
same `validateMessagePayload` content-type validation logic.

## Actors

- **Sender client**: a device authenticated with a valid JWT
- **Recipient device(s)**: target devices identified by their E2E device UUIDs
  (the `devices` row id)
- **Backend API**: Express app in `apps/backend/src/routes`

---

## 1. Send a message

### Endpoint

```text
POST /messages
```

### Auth

```text
Authorization: Bearer <jwt-from-auth-verify>
```

### Request JSON

```json
{
  "conversationId": "uuid (required)",
  "messageId": "uuid (required, client-generated for idempotency)",
  "contentType": "string (optional, defaults to 'text')",
  "ciphertext": "string (optional — encrypted payload)",
  "envelopes": [
    {
      "recipientDeviceId": "uuid (required)",
      "ciphertext": "string (required, min 1 char)"
    }
  ],
  "fileId": "uuid (optional — required when contentType is file/image/video/audio)"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `conversationId` | UUID | Yes | The conversation to post into |
| `messageId` | UUID | Yes | Client-generated; used for idempotency |
| `contentType` | string | No | Defaults to `"text"`. Trimmed and lowercased. |
| `ciphertext` | string | No | The encrypted message body |
| `envelopes` | array | No | Per-recipient-device encrypted payloads |
| `envelopes[].recipientDeviceId` | UUID | Yes (within envelope) | Must be a valid `devices.id` row |
| `envelopes[].ciphertext` | string | Yes (within envelope) | Must be at least 1 character |
| `fileId` | UUID | No | Required when `contentType` is `file`, `image`, `video`, or `audio` |

### Content-type validation

The endpoint runs `validateMessagePayload` which enforces:

- **file/image/video/audio**: `fileId` must be present
- **Other types**: `ciphertext` must be present
- **Envelopes**: if provided, each must have `recipientDeviceId` and non-empty
  `ciphertext`

Validation errors return `400` or `422` with a descriptive `error` message.

### Success responses

#### 201 Created — first-time send

```json
{
  "id": "uuid (the messageId you supplied)",
  "conversationId": "uuid",
  "senderId": "uuid",
  "senderDeviceId": "uuid | null",
  "contentType": "string",
  "ciphertext": "string | null",
  "fileId": "uuid | null",
  "createdAt": "ISO 8601 timestamp"
}
```

#### 200 OK — idempotent re-send

If a message with the same `messageId` already exists, the server returns the
existing record without inserting duplicates:

```json
{
  "messageId": "uuid",
  "createdAt": "ISO 8601 timestamp"
}
```

### Error responses

| Status | Body | Condition |
|---|---|---|
| 400 | `{"error":"…"}` | Zod validation failure (missing required field, bad UUID format) |
| 400/422 | `{"error":"…"}` | Content-type rule violation (e.g. file type without `fileId`) |
| 403 | `{"error":"Not a member of this conversation"}` | Authenticated user is not in the conversation |
| 500 | `{"error":"Failed to persist message"}` | Database transaction failure |

### Side effects

- **Broadcast**: On success the message is emitted via Socket.IO to the
  conversation room (`conversationId`) as a `new_message` event.
- **Cache invalidation**: All conversation members' caches are invalidated so
  their next fetch reflects the new message.
- **Envelope persistence**: If `envelopes` are provided, valid ones (whose
  `recipientDeviceId` exists in the `devices` table) are inserted into the
  `messageEnvelopes` table for later delivery/sync.

---

## 2. Delete a message

### Endpoint

```text
DELETE /messages/:id
```

### Auth

```text
Authorization: Bearer <jwt-from-auth-verify>
```

### Path parameter

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `:id` | UUID | Yes | The `messageId` to delete |

### Success response

```text
204 No Content
```

Body is empty.

### Error responses

| Status | Body | Condition |
|---|---|---|
| 400 | `{"error":"Message id is required"}` | Missing path parameter |
| 403 | `{"error":"You can only delete your own messages"}` | Authenticated user is not the sender |
| 404 | `{"error":"Message not found"}` | No message with that id exists |

### Side effects

- **Soft-delete**: The message row is updated with `deletedAt` timestamp and
  `ciphertext` is cleared. The row is not removed from the database.
- **Envelope cleanup**: All `messageEnvelopes` rows for this message are deleted.
- **File cleanup**: If the message had a `fileId`, the file record is
  soft-deleted via `softDeleteFile`.
- **Broadcast**: A `message_deleted` event is emitted to the conversation room
  with `{ messageId, conversationId }`.
- **Cache invalidation**: All conversation members' caches are invalidated.

---

## 3. Offline envelope sync

The `/sync` endpoint provides cursor-based, deterministically-ordered retrieval
of message envelopes addressed to a specific device. It is designed for
**offline catch-up**: a device that was offline reconnects, calls `/sync` with
its last-known cursor, and receives all envelopes it missed across every
conversation.

### Endpoint

```text
GET /sync
```

### Auth

```text
Authorization: Bearer <jwt-from-auth-verify>
```

### Query parameters

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `deviceId` | UUID | **Yes** | — | The E2E device id (from JWT or `/devices`) |
| `cursor` | string | No | — | Opaque cursor from a previous response's `nextCursor`; omit to start from the beginning of the retention window |
| `limit` | integer | No | `50` | Page size; capped at `SYNC_PAGE_SIZE` (configurable via env, default 50) |

### Request example

```text
GET /sync?deviceId=550e8400-e29b-41d4-a716-446655440000&cursor=1719876543210:abc123&limit=20
Authorization: Bearer eyJ...
```

### Cursor format

The cursor is **opaque** to the client. It encodes the envelope's `(createdAt,
id)` pair:

```
{createdAt.getTime()}:{envelope.id}
```

For example:

```
1719876543210:550e8400-e29b-41d4-a716-446655440001
```

**Why this format?** The cursor uses the envelope's own creation timestamp and
id (not the message's per-conversation sequence number), because offline-catchup
sync needs to order envelopes across *different* conversations for a single
device. The envelope's `(createdAt, id)` pair is comparable across every
conversation the device has envelopes in. The `id` serves as a tie-breaker for
envelopes created in the same millisecond.

Clients must:
- Store the `nextCursor` value from the most recent successful response
- Send it as the `cursor` parameter on the next sync request
- Treat the cursor as an opaque token — do not parse or interpret its
  internal structure

### Response shape

```json
{
  "envelopes": [
    {
      "id": "uuid (envelope row id)",
      "messageId": "uuid",
      "conversationId": "uuid",
      "senderId": "uuid",
      "senderDeviceId": "uuid | null",
      "contentType": "string",
      "ciphertext": "string (encrypted payload for this device)",
      "deliveredAt": "ISO 8601 timestamp | null",
      "createdAt": "ISO 8601 timestamp (envelope creation time)",
      "messageCreatedAt": "ISO 8601 timestamp (message creation time)"
    }
  ],
  "nextCursor": "string | null (opaque cursor for the next page)",
  "hasMore": "boolean (true if another page exists)"
}
```

| Field | Type | Notes |
|---|---|---|
| `envelopes` | array | Ordered by `(createdAt ASC, id ASC)` across all conversations |
| `envelopes[].id` | UUID | The `messageEnvelopes.id` — this is what the cursor encodes |
| `envelopes[].messageId` | UUID | The parent message |
| `envelopes[].conversationId` | UUID | Which conversation this belongs to |
| `envelopes[].senderId` | UUID | The user who sent the message |
| `envelopes[].senderDeviceId` | UUID \| null | The sending device |
| `envelopes[].contentType` | string | Message content type |
| `envelopes[].ciphertext` | string | Encrypted payload for this specific recipient device |
| `envelopes[].deliveredAt` | ISO 8601 \| null | When this envelope was first delivered via `/sync` |
| `envelopes[].createdAt` | ISO 8601 | Envelope creation time (drives ordering) |
| `envelopes[].messageCreatedAt` | ISO 8601 | When the parent message was sent |
| `nextCursor` | string \| null | Cursor for the next page; `null` when no more pages or same as input when page is empty |
| `hasMore` | boolean | `true` if more pages exist beyond the current one |

### How a client should persist/resume the cursor

The intended client flow for offline catch-up:

```text
1. Reconnect → call GET /sync?deviceId=<did>
2. Receive { envelopes: [...], nextCursor: "1719876543210:abc", hasMore: true }
3. Process envelopes, decrypt, display
4. Store nextCursor ("1719876543210:abc") in persistent local storage
5. If hasMore === true → call GET /sync?deviceId=<did>&cursor=1719876543210:abc
6. Repeat until hasMore === false
7. Store the final nextCursor for the next reconnection
```

Persist-resume example in pseudocode:

```
// On reconnect:
let cursor = localStorage.getItem("syncCursor")  // may be null on first sync
let hasMore = true

while (hasMore) {
  const params = new URLSearchParams({ deviceId })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`/sync?${params}`)
  const page = await res.json()

  for (const env of page.envelopes) {
    await decryptAndProcess(env)
  }

  cursor = page.nextCursor
  hasMore = page.hasMore

  // Persist after every page so partial progress is not lost on crash
  localStorage.setItem("syncCursor", cursor)
}
```

**On first sync** (no stored cursor): omit the `cursor` parameter. The server
returns all undelivered envelopes still within the TTL retention window.

**On subsequent reconnects**: send the last persisted `nextCursor`. The server
returns only envelopes created *after* that cursor. Because the pagination uses
an exclusive lower bound (`>` not `>=`), re-issuing the same cursor never
re-delivers an envelope the client already processed.

### Error responses

| Status | Body | Condition |
|---|---|---|
| 400 | `{"error":"deviceId is required"}` | Missing required `deviceId` query parameter |
| 400 | `{"error":"Invalid cursor"}` | Malformed cursor string |
| 403 | `{"error":"Device not found or not owned by this user"}` | Device does not exist or belongs to a different user |

### Retention window / TTL for undelivered envelopes

The server retains undelivered envelopes for a configurable duration controlled
by the environment variable `ENVELOPE_TTL_SECONDS`:

| Env variable | Default | Description |
|---|---|---|
| `ENVELOPE_TTL_SECONDS` | `604800` (7 days) | Maximum age of undelivered envelopes before they are excluded from sync |

#### What happens when a device is offline longer than the TTL window

- **Envelopes older than the TTL are silently excluded** from `/sync` responses.
  The server computes a cutoff timestamp (`now - ENVELOPE_TTL_MS`) and filters
  out any envelope whose `createdAt` is before the cutoff and which has not yet
  been marked as delivered.
- **Already-delivered envelopes are always excluded** from the result set (they
  appear only once, on the first sync that marks them delivered).
- **Messages with `deletedAt` set** are excluded regardless of TTL.
- **No error is returned**: the client simply receives fewer (or zero) envelopes.
  This means a device offline for, say, 8 days with the default 7-day TTL will
  **permanently miss** any envelopes that were created in that first day and
  were never delivered. The client should be prepared for gaps and may need to
  request re-sends or fall back to conversation-level history fetches for
  missing durable messages.

#### Delivery marking

When `/sync` returns a page of envelopes, it performs a **best-effort**
asynchronous update to mark those envelopes as delivered (`deliveredAt = now`).
This marking is fire-and-forget — it does not block the response, and failures
are silently ignored. A subsequent sync with the same cursor would
theoretically return the same envelopes if the delivery marking failed, but in
practice the cursor has already advanced.

### Configuration summary

| Env variable | Default | Description |
|---|---|---|
| `ENVELOPE_TTL_SECONDS` | `604800` | Retention window for undelivered envelopes (seconds) |
| `SYNC_PAGE_SIZE` | `50` | Maximum number of envelopes per page |

---

## Implementation references

- Message routes: `apps/backend/src/routes/messages.ts`
- Sync route: `apps/backend/src/routes/sync.ts`
- Message validation: `apps/backend/src/lib/validateMessagePayload.ts`
- Message schemas: `apps/backend/src/schemas/message.schemas.ts`
- Auth middleware: `apps/backend/src/middleware/auth.ts`
- Database schema (messages, messageEnvelopes, devices):
  `apps/backend/src/db/schema.ts`
- Message route tests: `apps/backend/src/__tests__/messages.routes.test.ts`
- Sync route tests: `apps/backend/src/__tests__/sync.routes.test.ts`
