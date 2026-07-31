# Message Pipeline

This document traces every hop a message takes from the moment a user hits Send to the moment it renders in a recipient's thread. It covers:

1. **Outbound path** — compose → encrypt → envelope → emit → optimistic UI → ack reconciliation
2. **Inbound path** — live socket delivery vs. `/sync` backfill and how they merge without duplication
3. **Failure and unavailable states** — what the UI shows and why

---

## 1. Outbound path

### 1.1 Compose and intent

The user types in `MessageInput` (`src/components/chat/MessageInput.tsx`). As the user types, `socket.emit('typing_start', { conversationId })` fires and re-arms a 2-second silence timer that emits `typing_stop`. Pressing Enter or clicking Send calls `handleSendText`.

For a payment message the user fills in the pay popover, which calls `transferToken` (Soroban smart contract via `src/lib/soroban.ts`) and then wraps the resulting `txHash` in a JSON payload that is also passed to `send_message`.

### 1.2 Encrypt into a per-device envelope

Before the message leaves the browser, the sender must produce one encrypted **envelope** for every recipient device (and for every sibling device the sender owns on other browsers/tabs).

The encryption layer lives in `src/lib/x3dh.ts` and `src/lib/crypto/`. The session key comes from a prior X3DH (Extended Triple Diffie–Hellman) key exchange:

1. The initiator fetches the recipient device's prekey bundle from `GET /devices/:id/bundle`.
2. `initiateSession(bundle, myIdentity)` runs three or four X25519 DH operations and feeds the result through HKDF-SHA-256 to derive a 32-byte AES-GCM session key.
3. The session key is stored in memory via `sessionStore` (`src/lib/crypto/sessionStore.ts`).
4. The plaintext is encrypted with `AES-GCM` using a fresh 12-byte IV. The resulting `{ v, iv, ct }` object is base64-JSON-encoded into a `ciphertext` string.
5. An Ed25519 signature over `iv || ct` is appended as `sig` so the recipient can verify authenticity before decrypting.

Each recipient device gets a distinct `{ recipientDeviceId, ciphertext }` pair. Sibling devices (other devices owned by the sender) also receive their own envelope so they can decrypt the message when they next connect (issue #188).

### 1.3 Emit via the socket dispatcher

`socket.emit('send_message', { conversationId, messageId, ciphertext, envelopes: [...] })`

`messageId` is a client-generated UUID. The backend deduplicates on this id, so the client can re-emit after a disconnect without risk of double-insertion (see §1.6).

The socket event is wrapped in an `EventEnvelope` by `emitSocketEnvelope` (`src/lib/realtime.ts`) and delivered over the `dispatch` channel.

### 1.4 Backend processing (`send_message` handler)

`apps/backend/src/socket/messaging.ts` — `dispatcher.register('send_message', ...)`:

1. **Validation** — `validateMessagePayload` checks that at least one of `ciphertext`, `content`, `envelopes`, or `fileId` is present.
2. **Membership check** — the socket user must be a `conversation_members` row.
3. **Idempotency check** — if `messages.id = messageId` already exists the handler immediately emits `message_ack` and returns; no duplicate row is created.
4. **Sibling-device coverage** — `fetchSiblingDeviceIds` lists non-revoked sibling devices. If the client omitted any, the handler returns a `device_set_mismatch` error with the missing IDs so the client can re-encrypt and retry.
5. **Atomic write** — a single Postgres transaction inserts the `messages` row and all `message_envelopes` rows. Either all persist or none do.
6. **Ack** — `socket.emit('message_ack', { messageId, createdAt })` is sent back to the sender.
7. **Delivery fan-out** — `deliverMessage(io, message, conversationId)` is called (§1.5).
8. **Cache invalidation** — per-user conversation caches in Redis are purged.
9. **Offline push** — `dispatchOfflinePush` queues Web Push notifications for devices that are not currently connected.

### 1.5 Delivery fan-out (`deliverMessage`)

`apps/backend/src/services/deliveryPipeline.ts`:

1. Re-fetches current `conversation_members` from Postgres (not from room state, which can lag).
2. Resolves every active (non-revoked) device for those members.
3. Loads only the `message_envelopes` rows already committed for those devices.
4. For each device that has an envelope: `io.to(deviceRoom(deviceId)).emit('message_envelope', { ..., ciphertext })`. Each device's socket joins its own `device:<id>` room on connect, so the envelope is routed to exactly the right socket even across multiple server instances via the Redis adapter.
5. Emits `new_message` (without `ciphertext`) to the conversation room for UI updates (unread counts, scroll triggers).

### 1.6 Optimistic UI update and ack reconciliation

The current `MessageInput` (`src/components/chat/MessageInput.tsx`) sends the message and clears the input immediately. The `useMessageHistory` hook (`src/hooks/useMessageHistory.ts`) appends the authoritative message when the `new_message` socket event arrives. Because `new_message` carries no ciphertext, the rendered text comes from the decrypted plaintext already held in the sender's own `plaintextCache` (`src/lib/crypto/plaintextCache.ts`).

Reconciliation against the `message_ack`:

- The backend's `message_ack` event carries `{ messageId, createdAt }`. If the client re-emits the same `messageId` after a disconnect, the backend's idempotency check prevents a duplicate row; the ack is re-sent with the original `createdAt`, so the client's UI timestamp stays stable.
- `useMessageHistory` deduplicates by `id` before inserting into the list (`seen.has(m.id)` check), so a race between an optimistic insert and the incoming `new_message` does not create two rows.

---

## 2. Inbound path

### 2.1 Overview of the two delivery channels

A recipient device receives messages through exactly one of two paths, but the **processing code is the same for both**. That shared code is `useInboundPipeline` and `processInboundEnvelope`.

| Channel | When used | Source |
|---|---|---|
| Live `message_envelope` socket event | Device is connected when message is sent | `deliverMessage` in the backend |
| `/sync` HTTP backfill | Device reconnects after an offline period | `GET /sync` route |

### 2.2 Live socket delivery

On connect, `useSocket` / `initSocket` join the socket to `device:<deviceId>` via the server-side `join_room` implicit room join.

When a message is sent, `deliverMessage` emits `message_envelope` to `device:<deviceId>`. The `socket.on('message_envelope', ...)` handler inside `useInboundPipeline` (`src/hooks/useInboundPipeline.ts`) receives it and calls `handleEnvelope(input)`.

A second event, `new_message` (without ciphertext), is emitted to the conversation room simultaneously. `useInboundPipeline` receives `new_message` via `onNewMessage → ingestMeta`, which immediately inserts a `status: 'pending'` placeholder into the message map so the thread scrolls and shows activity.

A third event, `device_envelope`, carries only ciphertext and is used for cross-node delivery where metadata arrives separately. `onDeviceEnvelope → ingestCiphertext` stores it in `pendingCiphertext` until the corresponding `new_message` metadata arrives, at which point `tryProcessPending` assembles the full input.

### 2.3 `/sync` backfill on reconnect

`useSocket` (`src/hooks/useSocket.ts`) fires on every `connect` event:

```
onConnect → resumeThenSync()
  → emitSocketEnvelope(socket, 'resume', { lastEventId })
  → runSocketSync(socket, token)         // src/lib/realtime.ts
```

`resume` replays lightweight ephemeral events (read receipts, presence changes) stored in a Redis stream (5-minute TTL, max 500 entries). The backend replies with `resume_complete`; if `syncRequired` is true the client also runs `runSocketSync`.

`runSocketSync` polls `GET /sync?deviceId=<id>&sinceSequence=<cursor>` in a paginated loop (page size 50 by default, configurable via `SYNC_PAGE_SIZE`). The backend:

1. Verifies device ownership.
2. Queries `message_envelopes` for this device ordered by `(createdAt, id)` — a stable cursor across all conversations, not per-conversation sequence numbers.
3. Returns only envelopes within the 7-day retention window (`ENVELOPE_TTL_SECONDS`).
4. Marks returned envelopes as delivered (best-effort, does not block the response).

For each envelope, `runSocketSync` replays it by calling `replaySocketEvent(socket, 'message_envelope', payload)` — this re-fires the local socket listeners as if the event had arrived live, so `useInboundPipeline` processes it through exactly the same path. It also replays a `new_message` (with `ciphertext: null`) and emits `message_delivered` back to the server.

`useInboundPipeline` (`src/hooks/useInboundPipeline.ts`) also has its own independent sync loop, `runSync`, which calls `GET /sync` directly and feeds each envelope to `handleEnvelope`. The `syncCursor` ref is advanced per call so consecutive calls request only newer envelopes.

### 2.4 The shared `handleEnvelope → processInboundEnvelope` path

Both live and backfill paths converge at `handleEnvelope`:

```
handleEnvelope(input: EnvelopeInput)
  → processing.current (dedup guard — prevents parallel processing of the same messageId)
  → processInboundEnvelope(input, token)   // src/lib/crypto/processEnvelope.ts
      → getCachedPlaintext(messageId)      // in-memory cache; fast path for re-delivery
      → if no senderDeviceId: return unavailable/pre-link
      → fetchSenderDevicePublicKey(senderDeviceId, token)   // HTTP GET, in-memory cached
      → decryptAndVerifyEnvelope(ciphertext, senderDeviceId, identityPublicKey)
            → parseEnvelopePayload()   // base64-decode JSON { v, iv, ct, sig? }
            → if sig: verifyEnvelopeSignature()   // Ed25519 verify(sig, iv||ct)
            → getSessionKey(senderDeviceId)       // in-memory AES-GCM key
            → crypto.subtle.decrypt(AES-GCM)
      → setCachedPlaintext(messageId, plaintext)
      → return InboundMessage { status: 'decrypted', plaintext }
  → upsertMessage(result)
```

`upsertMessage` calls `mergeInboundMessage(existing, incoming)`:

- If the existing record is already `decrypted`, it is kept (idempotent re-delivery cannot downgrade a decrypted message to pending).
- If the incoming record is `decrypted` and the existing is not, the incoming wins.
- Otherwise the incoming record merges over the existing metadata.

The resulting `Map<messageId, InboundMessage>` is converted by `useMemo` to an array sorted by `sequenceNumber` for rendering.

### 2.5 Deduplication: how live and backfill do not double-render

Three independent guards prevent a message from appearing twice:

1. **`processing.current` ref** — a `Set<messageId>` inside `useInboundPipeline`. If `handleEnvelope` is already running for a given id, subsequent calls for the same id are dropped immediately.
2. **`plaintextCache`** — the very first successful decrypt writes the plaintext. Every subsequent call to `processInboundEnvelope` for that id hits the cache and returns a `decrypted` result without re-running crypto.
3. **`mergeInboundMessage`** — the state map is keyed by `messageId`. `upsertMessage` always calls `setMessagesById(prev => { const next = new Map(prev); next.set(id, merge(existing, incoming)); return next; })`. A second delivery of the same id is a map-key overwrite, not a new entry, so the rendered list never grows.

The `useMessageHistory` hook (used by `MessageThread`) applies its own guard: `if (current.some(m => m.id === msg.id)) return current;` before appending a `new_message` event.

---

## 3. Failure and unavailable states

### 3.1 No session key (pre-link message)

**Cause:** The message was encrypted for a session key that was established before the current device linked to the account, or the session key was never stored (e.g., browser storage cleared).

**Detection:** `getSessionKey(senderDeviceId)` returns `null` inside `decryptAndVerifyEnvelope`, throwing `PreLinkError`.

**`processInboundEnvelope` returns:**
```ts
{ status: 'unavailable', unavailableReason: 'pre-link' }
```

The `/sync` backfill also propagates this: if the server-side envelope's `unavailable: true` flag is set, `ingestMeta` in `useInboundPipeline` sets the message directly to `unavailable/pre-link` without waiting for ciphertext.

**UI (`UnavailableMessagePlaceholder`):**
> 🔒 *Waiting for secure session — message from before this device was linked.*

### 3.2 Signature verification failure

**Cause:** The `sig` field in the envelope payload does not verify against the sender's registered Ed25519 identity key. Possible causes: message tampering, key rotation not yet synced, or a logic error in the sender's signing code.

**Detection:** `crypto.subtle.verify` returns `false` in `verifyEnvelopeSignature`, throwing `VerificationFailedError`.

**`processInboundEnvelope` returns:**
```ts
{ status: 'unavailable', unavailableReason: 'verification-failed' }
```

**UI (`UnavailableMessagePlaceholder`):**
> 🔒 *Message could not be verified.*

### 3.3 AES-GCM decryption failure

**Cause:** The session key is present but the ciphertext cannot be decrypted — key mismatch, corrupted data, or truncated envelope.

**Detection:** `crypto.subtle.decrypt` throws, caught and re-thrown as `DecryptError`.

**`processInboundEnvelope` returns:**
```ts
{ status: 'unavailable', unavailableReason: 'undecryptable' }
```

**UI (`UnavailableMessagePlaceholder`):**
> 🔒 *Unable to decrypt this message.*

### 3.4 Missing `senderDeviceId`

**Cause:** The message was sent without E2EE (e.g., a legacy system message or a message sent before device registration), so `senderDeviceId` is null.

**Detection:** `processInboundEnvelope` checks `!envelope.senderDeviceId` before attempting any crypto.

**`processInboundEnvelope` returns:**
```ts
{ status: 'unavailable', unavailableReason: 'pre-link' }
```

**UI:** Same pre-link placeholder as §3.1.

### 3.5 Pending (ciphertext not yet arrived)

**Cause:** `new_message` (metadata) arrived before the corresponding `device_envelope` or `message_envelope` event. This is transient.

**Detection:** `ingestMeta` cannot find a matching entry in `pendingCiphertext`, so it calls `upsertMessage` with `status: 'pending'`.

**UI:** The message row renders as pending. When the ciphertext arrives (via `ingestCiphertext → tryProcessPending → handleEnvelope`), `upsertMessage` overwrites the pending record with a `decrypted` one. No user action is needed; no explicit loading indicator is shown for pending — the transition is fast enough under normal conditions to be imperceptible.

### 3.6 Socket disconnected / offline

**Cause:** Network loss, server restart, or browser backgrounding.

**What the UI shows:**

- `useSocket` has `reconnection: true` with Socket.IO's default exponential back-off. No explicit "disconnected" banner is rendered by the pipeline itself; the conversation header in `apps/web/src/app/chat/page.tsx` shows `Disconnected` next to the room name when `socket?.connected` is false.
- In the conversations page (`/app/conversations/[id]`), initial data is fetched over HTTP (`GET /conversations/:id/messages`) independently of the socket. If the HTTP fetch fails, the full page replaces with an `EmptyState`:
  > **Conversation unavailable** — *[server error message]*
- `useInboundPipeline` sets `syncing: true` while the `/sync` loop is in flight. This flag is exposed to the parent page to optionally show a sync indicator.
- Messages that arrived while offline are recovered on reconnect through the `runSync` / `runSocketSync` cycle (§2.3). The cursor stored in `localStorage` ensures the sync picks up exactly from the last known position.

### 3.7 `/sync` HTTP error

**Cause:** The `/sync` endpoint returns a non-2xx response (e.g., expired token, device not found, network timeout).

**Detection:** Both `runSocketSync` (`src/lib/realtime.ts`) and `useInboundPipeline`'s `runSync` check `if (!res.ok) return` / `break`, exiting the pagination loop silently.

**What the UI shows:** `syncing` is set back to `false` and no error is surfaced to the user. Any messages missed in that sync window remain absent from the thread until the next successful sync (next reconnect or manual refresh). There is currently no retry back-off or user-visible error for a sync failure.

### 3.8 `send_message` errors from the server

The server can reject a message in several ways, each returning a named error event:

| Server error | `event` field | Meaning |
|---|---|---|
| Missing `messageId` | `send_message` | Client bug |
| Not a conversation member | `send_message` | Auth/membership issue |
| Sibling devices missing envelopes | `device_set_mismatch` | Client must re-encrypt for the listed device IDs |
| DB write failure | `send_message` | Transient; retry advised |

The `MessageInput` component emits `send_message` and the `ChatPage` listens on `socket.on('error', ...)`, displaying the error message in a red bar above the input. No retry logic is currently implemented client-side for `device_set_mismatch`.

---

## Sequence diagrams

### Outbound (normal)

```
User          MessageInput       Socket          Backend           Recipients
 |                |                |                |                  |
 |--[type+Send]-->|                |                |                  |
 |                |--emit send_message + envelopes->|                  |
 |                |                |                |--DB insert------->|
 |                |                |                |--message_ack------>|
 |                |                |                |--message_envelope->| (device room)
 |                |                |                |--new_message------>| (conversation room)
 |                |<--new_message--|                |                  |
```

### Inbound live (recipient online)

```
Backend           deviceRoom(id)   useInboundPipeline   processEnvelope
  |                    |                  |                    |
  |--message_envelope->|                  |                    |
  |                    |--handleEnvelope->|                    |
  |                    |                  |--fetchDeviceKey--->|
  |                    |                  |<--identityKey------|
  |                    |                  |--decryptAndVerify->|
  |                    |                  |<--plaintext--------|
  |                    |                  |--upsertMessage---->|
  |                    |                  | (status: decrypted)|
  |--new_message------>|                  |                    |
  |                    |--ingestMeta----->|                    |
  |                    |                  |(merges/no-ops on   |
  |                    |                  | existing decrypted)|
```

### Reconnect / backfill

```
useSocket          GET /sync         useInboundPipeline
  |                   |                     |
  |--connect event--->|                     |
  |--emit resume----->|                     |
  |<--resume_complete-|                     |
  |--runSocketSync--->|                     |
  |                   |--GET /sync?cursor=0->|
  |                   |<--{envelopes, next}--|
  |                   | replaySocketEvent    |
  |                   |--message_envelope--->| (same path as live)
  |                   |--cursor advance----->|
  |                   | (loop until !hasMore)|
```

---

## Key source locations

| Concern | File |
|---|---|
| Socket init and resume | `src/hooks/useSocket.ts`, `src/lib/socket.ts`, `src/lib/realtime.ts` |
| Inbound pipeline hook | `src/hooks/useInboundPipeline.ts` |
| Envelope decrypt/verify | `src/lib/crypto/processEnvelope.ts`, `src/lib/crypto/decrypt.ts` |
| Crypto types and errors | `src/lib/crypto/types.ts` |
| Session key store | `src/lib/crypto/sessionStore.ts` |
| Device key cache | `src/lib/crypto/deviceKeys.ts` |
| Plaintext cache | `src/lib/crypto/plaintextCache.ts` |
| X3DH key exchange | `src/lib/x3dh.ts` |
| Message thread UI | `src/components/messaging/MessageThread.tsx` |
| Unavailable placeholder | `src/components/messaging/UnavailableMessagePlaceholder.tsx` |
| Pagination (load older) | `src/hooks/useMessageHistory.ts` |
| Backend send handler | `apps/backend/src/socket/messaging.ts` |
| Backend fan-out | `apps/backend/src/services/deliveryPipeline.ts` |
| Backend `/sync` route | `apps/backend/src/routes/sync.ts` |
| Ephemeral event replay | `apps/backend/src/services/resumeStream.ts` |
