# Conversations API

Routes implemented in [`src/routes/conversations.ts`](../src/routes/conversations.ts), mounted at `/conversations`. Every route in this file is behind `requireAuth` (`conversationsRouter.use(requireAuth)`), so all requests require:

```
Authorization: Bearer <jwt>
```

The JWT is device-scoped — it encodes both `userId` and `deviceId` (see [`middleware/auth.ts`](../src/middleware/auth.ts)). `deviceId` is what drives the per-device envelope filtering described in [Per-device ciphertext scoping](#per-device-ciphertext-scoping) below.

Common auth failure responses (identical across every route in this file, since they all sit behind the same middleware):

| Status | Body | Cause |
|---|---|---|
| 401 | `{ "error": "Missing or invalid Authorization header" }` | No `Bearer` token |
| 401 | `{ "error": "Invalid or expired token" }` | JWT fails verification |
| 401 | `{ "error": "Token missing deviceId" }` | Token isn't device-scoped |
| 401 | `{ "error": "Device not found or has been revoked" }` | Device was revoked since the token was issued |

Below, only per-route authorization/validation failures are listed in addition to these.

> **Note on "create":** there is no `POST /conversations` REST route. Conversations are created via the Socket.IO `create_conversation` event (`src/socket/messaging.ts`), which inserts the `conversations` row and the initial `conversationMembers` rows, then emits `conversation_created` back to the creator's socket. This document covers REST only; see the Socket.IO event dispatcher docs for that flow.

---

## GET /conversations

List all conversations the authenticated user belongs to.

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `archived` | `"true"` \| omitted | omitted | Pass `archived=true` to list archived conversations instead of the default (non-archived) view. |

**Response `200`** — array of conversation objects, each augmented with the caller's per-membership flags and counts:

```jsonc
[
  {
    "id": "uuid",
    "type": "dm" | "group",
    "name": "string | null",
    "avatarUrl": "string | null",
    "createdAt": "ISO timestamp",
    "members": [
      {
        "joinedAt": "ISO timestamp",
        "user": {
          "id": "uuid",
          "username": "string | null",
          "avatarUrl": "string | null",
          "wallets": [{ "address": "string", "isPrimary": boolean }]
        }
      }
    ],
    "messages": [
      // 0 or 1 entry — the most recent message, envelope-filtered for this device.
      // See "serialized message shape" below.
    ],
    "isMuted": boolean,
    "isArchived": boolean,
    "messageCount": number,
    "unreadCount": number
  }
]
```

Notes:
- `messages` is the latest message only (used for list previews), pre-filtered to this device's envelope — see [Per-device ciphertext scoping](#per-device-ciphertext-scoping).
- `unreadCount` is computed from `conversationMembers.lastReadMessageId`: it's `0` when the member has no read position established yet (`lastReadMessageId IS NULL`), otherwise it's the count of non-deleted messages created after that message's `createdAt`.
- **Caching**: for the default (non-archived) view only, the full response is cached in Redis under a per-user key for `CONV_CACHE_TTL` seconds (30s). `archived=true` always bypasses the cache (it's a different result set). Cache reads/writes fail open — any Redis error falls through to a live DB query rather than erroring the request. The cache is invalidated on writes that affect membership/conversation data (see `invalidateConversationCaches` calls in the mutation routes below) and on settings changes.

---

## GET /conversations/:id

Fetch a single conversation by ID, including members and the latest message (envelope-filtered for the caller's device), plus a membership check.

**Response `200`** — same conversation shape as the list endpoint, minus `isMuted`/`isArchived`/`messageCount`/`unreadCount` (this endpoint returns the raw serialized conversation + members + latest message, not the list-view aggregation).

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` param (defensive; shouldn't occur via routing) |
| 404 | `{ "error": "Conversation not found" }` | No conversation with that ID |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |

---

## GET /conversations/:id/messages

Cursor-paginated message history for a conversation. This is the primary route where per-device envelope filtering matters — see below.

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `30` (`DEFAULT_MESSAGES_LIMIT`) | Clamped to a max of `50` (`MAX_MESSAGES_LIMIT`). Non-numeric or non-positive values fall back to the default. |
| `before` | message UUID | none | Cursor — see [Pagination](#pagination) below. |

**Response `200`**

```jsonc
{
  "messages": [ /* ascending (oldest-first) order, envelope-filtered for this device */ ],
  "nextCursor": "uuid | null"
}
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |
| 400 | `{ "error": "Invalid cursor" }` | `before` doesn't reference an existing message |

### Pagination

- Pagination is **backward** (walking from newest toward oldest) using the `before` cursor, which must be a message `id` from a previous page's `nextCursor` (or omitted to fetch the most recent page).
- The cursor is resolved server-side to that message's `(createdAt, id)` pair, and the next page is every message with `createdAt < cursor.createdAt`, OR (`createdAt == cursor.createdAt` AND `id < cursor.id`). The `id` tie-break exists because `createdAt` alone can silently skip or duplicate rows across pages when multiple messages share the same millisecond timestamp under concurrent writes.
- Internally the query fetches DESC by `(createdAt, id)` — i.e. newest-first — requests `limit + 1` rows to detect whether a further page exists, trims to `limit`, and then **reverses the page before returning it**. The client-facing `messages` array is therefore always in **ascending (oldest-first) order**, regardless of pagination direction.
- `nextCursor` is the `id` of the oldest message in the *untrimmed, pre-reverse* page (i.e., the next `before` value to fetch the page immediately preceding this one) — `null` when there is no older page (fewer than `limit + 1` rows existed).
- There is no forward/"after" cursor on this route — pagination is one-directional (backward from the most recent message, or from an explicit `before` point).

---

## GET /conversations/:id/members

List all members of a conversation, ordered by `joinedAt` ascending.

**Response `200`**

```jsonc
{
  "members": [
    {
      "id": "uuid",              // user id
      "username": "string | null",
      "avatarUrl": "string | null",
      "primaryWalletAddress": "string | null", // primary wallet, else first wallet, else null
      "joinedAt": "ISO timestamp"
    }
  ]
}
```

**Errors**

| Status | Body | Cause |
|---|---|---|
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |

---

## POST /conversations/:id/members

Add a member to a group conversation. Requires the caller to already be a member. Not permitted on DM conversations (DMs are fixed at exactly 2 members).

**Body**

```json
{ "userId": "uuid" }
```

**Response `201`**

```jsonc
{
  "id": "uuid",              // conversationMembers row id
  "conversationId": "uuid",
  "userId": "uuid",
  "joinedAt": "ISO timestamp"
}
```

Side effects: invalidates the conversation-list cache for every member of the conversation, and emits a `member_joined` Socket.IO event (`{ userId, conversationId }`) to the conversation's room.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 400 | `{ "error": "userId is required" }` | Missing/non-string `userId` in body |
| 404 | `{ "error": "Conversation not found" }` | No conversation with that ID |
| 400 | `{ "error": "DM conversations cannot add members" }` | `conversation.type === 'dm'` |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |
| 409 | `{ "error": "User is already a member" }` | Target user already has a membership row |
| 409 | `{ "error": "Database conflict or validation error" }` | Insert failed (e.g. race / constraint violation) |

---

## PATCH /conversations/:id

Update a group conversation's `name` and/or `avatarUrl`. Only members may update; not permitted on DM conversations.

**Body** — at least one of:

```json
{ "name": "string", "avatarUrl": "string" }
```

**Response `200`** — the updated conversation row (`id`, `type`, `name`, `avatarUrl`, `createdAt`).

Side effects: invalidates the conversation-list cache for every member, and emits a `conversation_updated` event (`{ id, type, name, avatarUrl, createdAt }`) to the conversation's room.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 400 | `{ "error": "At least one of name or avatarUrl must be provided" }` | Empty body |
| 400 | `{ "error": "name must be a string" }` / `{ "error": "avatarUrl must be a string" }` | Wrong type |
| 404 | `{ "error": "Conversation not found" }` | No conversation with that ID |
| 400 | `{ "error": "DM conversations cannot be updated" }` | `conversation.type === 'dm'` |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |
| 500 | `{ "error": "Failed to update conversation" }` | Update returned no row, or threw |

---

## PATCH /conversations/:id/settings

Update the **caller's own** per-membership mute/archive state (this is per-member state, not a conversation-wide setting — muting/archiving a conversation only affects your own view of it).

**Body** — at least one of:

```json
{ "muted": boolean, "archived": boolean }
```

**Response `200`**

```json
{ "isMuted": boolean, "isArchived": boolean }
```

Side effects: deletes the caller's conversation-list cache entry (forcing a fresh read on next `GET /conversations`).

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 400 | `{ "error": "At least one of muted or archived is required" }` | Empty body |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |

---

## DELETE /conversations/:id/leave

Leave a group conversation. Not permitted on DMs (leaving a DM isn't a supported operation — DMs are left implicitly by ignoring them, not deleted).

If the caller is the **last** remaining member, the conversation row itself is deleted (cascading to members, messages, etc. via FK `onDelete: 'cascade'`). Otherwise, only the caller's membership row is removed.

**Response `204`** — no body.

Side effects: invalidates the conversation-list cache for every member who was in the conversation prior to the leave.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 404 | `{ "error": "Conversation not found" }` | No conversation with that ID |
| 400 | `{ "error": "DM conversations cannot be left" }` | `conversation.type === 'dm'` |
| 404 | `{ "error": "Conversation membership not found" }` | Caller has no membership row for this conversation |

---

## GET /conversations/:id/devices

Returns the full set of active (non-revoked) devices belonging to every member of the conversation. The web client calls this before encrypting an outgoing message, so it knows exactly which devices need an envelope (one ciphertext per recipient device — see [Per-device ciphertext scoping](#per-device-ciphertext-scoping)).

**Response `200`**

```jsonc
{
  "devices": [
    {
      "id": "uuid",
      "userId": "uuid",
      "identityPublicKey": "string",
      "deviceName": "string | null",
      "platform": "string | null"
    }
  ]
}
```

Only devices with `revokedAt IS NULL` are included.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |

---

## GET /conversations/:id/search — removed

**Response `410 Gone`**:

```json
{
  "error": "Server-side search removed; search is now client-side over decrypted messages",
  "docs": "https://github.com/DripWave/clicked/blob/main/docs/message-encryption-migration.md"
}
```

Kept only to return a clear error to old clients. Search is now performed client-side over locally decrypted messages (see `apps/web/src/lib/search`), since the server has no plaintext to search against.

---

## POST /conversations/:id/transfers

Record an on-chain token transfer against a conversation (e.g. after a client submits a Soroban `token_transfer` invocation and gets a tx hash back). Requires membership.

**Body**

```json
{
  "recipient_address": "string",   // or recipientAddress
  "amount": "string | number",
  "token_contract_id": "string",   // or tokenContractId
  "tx_hash": "string",             // or txHash
  "memo": "string | null"          // optional
}
```

Both snake_case and camelCase field names are accepted (`recipient_address`/`recipientAddress`, etc.).

**Response `201`** — the inserted `tokenTransfers` row.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |
| 400 | `{ "error": "recipientAddress, amount, tokenContractId, and txHash are required" }` | Missing required field |
| 409 | `{ "error": "Transaction hash already exists" }` | `txHash` already recorded (idempotency guard) |
| 409 | `{ "error": "Database conflict or validation error" }` | Insert failed |

---

## GET /conversations/:id/transfers

List token transfers recorded against a conversation, newest first.

**Response `200`** — array of `tokenTransfers` rows.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "Conversation id is required" }` | Missing `:id` |
| 403 | `{ "error": "Not a member of this conversation" }` | Caller isn't a member |
| 500 | `{ "error": "Failed to retrieve transfers" }` | Query threw |

---

## Per-device ciphertext scoping

**Why two callers can fetch the same conversation and get different `ciphertext` bytes for the same `messages[]` entry:**

Messages are end-to-end encrypted per-recipient-*device*, not per-recipient-*user* or per-conversation. When a message is sent, the sender's client encrypts the plaintext separately for every active device of every recipient (fetched via `GET /conversations/:id/devices`) and uploads one `message_envelopes` row per device:

```
message_envelopes(messageId, recipientDeviceId, recipientUserId, ciphertext, deliveredAt, readAt)
```

Every route in this file that returns message content (`GET /conversations` latest-message preview, `GET /conversations/:id` latest message, `GET /conversations/:id/messages`) filters the `envelopes` relation to:

```ts
where: eq(messageEnvelopes.recipientDeviceId, req.auth!.deviceId)
```

— i.e. **only the envelope addressed to the calling device**. This is resolved in `serializeMessage()` (`src/lib/messages.ts`):

1. If the message is soft-deleted (`deletedAt` set), `ciphertext` is always `null`.
2. Else if an envelope exists for this device, that envelope's `ciphertext` is returned (this is the normal case for E2EE messages).
3. Else if the message row itself has a `ciphertext` (system messages, or legacy pre-envelope messages), that's returned instead.
4. Else `ciphertext: null` with `unavailable: true` — the caller's device doesn't have an envelope for this message (e.g. it's a device that was added *after* the message was sent, or was offline during fan-out) and cannot decrypt it.

**Consequences**:
- Two devices belonging to the *same* user, or two different members of a group conversation, each hold their own device-scoped ciphertext for the same logical message — the bytes differ because each was encrypted against a different device's public key, even though the underlying plaintext is identical.
- A message can be `unavailable: true` for one device while fully present for another — this is expected when a device joins late or missed the original fan-out, not a bug. Clients should treat `unavailable: true` as "cannot decrypt on this device" rather than "message doesn't exist."
- Because filtering happens per-request based on `req.auth!.deviceId` (the device embedded in the caller's JWT), the same user calling from two different logged-in devices will see different `ciphertext` for the same message ID in the same `GET /conversations/:id/messages` response shape — this is expected behavior, not a caching bug.
