# Frontend type contracts for API responses

This document catalogs the TypeScript types `apps/web` uses to model backend REST and Socket.IO responses, and checks each one against what the backend (`apps/backend`) actually sends.

## Scope note: there is no response-side schema in the backend

Before comparing types, one thing needs to be stated up front: **the backend has no Zod (or any) schema that validates or shapes outgoing responses.** The only Zod schemas in `apps/backend/src/schemas/` (`auth.schemas.ts`, `message.schemas.ts`) validate *inbound request bodies* — `ChallengeSchema`, `VerifySchema`, `DeviceSchema` for `/auth/*` and `/devices`, and `SendMessageSchema`/`EnvelopeSchema` for `POST /messages`. A handful of routes (`treasury.ts`, `uploads.ts`, `devices.ts`) also define inline Zod schemas, but again only for request validation.

So "the backend schema a frontend type is meant to correspond to" below means: the literal shape returned by `res.json(...)` in the route handler — usually a raw Drizzle row (`typeof table.$inferSelect`), a `db.query...with:{...}` relational result, or a hand-built object literal — or, for Socket.IO, the payload object literal passed to `.emit(...)`. The one semi-shared transform is `serializeMessage()` (`apps/backend/src/lib/messages.ts:13-50`), which normalizes a message's `ciphertext` per-device (see [`api-conversations.md`](../../backend/docs/api-conversations.md) for the full explanation) — but it is applied inconsistently (noted per-entity below).

Because there's no shared source of truth, the same conceptual entity (Message, Conversation, Device, Proposal) has been **independently redefined in multiple frontend files**, several of which have drifted from both the backend and each other. Each subsection below lists every redefinition found, not just one canonical one.

---

## Message

### `apps/web/src/app/conversations/[id]/page.tsx:17-31`
```ts
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: string | null;
  contentType?: string;
  content?: string;
  ciphertext?: string | null;
  sequenceNumber?: number;
  createdAt: string;
  pending?: boolean;
  delivered?: boolean;
  readBy?: string[];
  sender?: Sender;
}
```
Models: `GET /conversations/:id/messages`, and socket `message_history` / `new_message` / `message_envelope` / `message_ack` / `delivery_receipt` / `read_receipt`.

### `apps/web/src/app/app/conversations/[id]/page.tsx:32-42`
```ts
type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  content?: string | null;
  ciphertext?: string | null;
  contentType?: string | null;
  createdAt: string;
  sender?: Sender;
  unavailable?: boolean;
};
```
Models the same events as above, at a second, parallel conversation route — narrower field set (no `senderDeviceId`, `sequenceNumber`, `pending`, `delivered`, `readBy`).

### `apps/web/src/components/conversations/ConversationListSidebar.tsx:28-32`
```ts
interface Message {
  id: string;
  content: string;
  createdAt: string;
}
```
Models the `messages[0]` last-message-preview sub-object embedded in each item of `GET /conversations`'s response array.

### `apps/web/src/hooks/useMessageHistory.ts:12-22` (`ChatMessage`)
```ts
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  ciphertext?: string | null;
  contentType?: string;
  sequenceNumber?: number | null;
}
```
Models the socket `message_history` ack and `new_message`.

### `apps/web/src/lib/crypto/types.ts:6-16` (`MessageEnvelopeEvent`)
```ts
export interface MessageEnvelopeEvent {
  messageId: string; conversationId: string; senderId: string;
  senderDeviceId: string | null; contentType: string;
  sequenceNumber: number; createdAt: string; envelopeId: string; ciphertext: string;
}
```
Models socket `message_envelope`, emitted from `apps/backend/src/services/deliveryPipeline.ts:78-87`.

### `apps/web/src/lib/crypto/types.ts:19-24` (`DeviceEnvelopeEvent`)
```ts
export interface DeviceEnvelopeEvent {
  messageId: string; conversationId: string; ciphertext: string; sequenceNumber: number;
}
```
Models socket `device_envelope`.

### `apps/web/src/lib/crypto/types.ts:27-38` (`SyncEnvelope`)
```ts
export interface SyncEnvelope {
  id: string; messageId: string; conversationId: string; ciphertext: string;
  sequenceNumber: number; senderId: string; senderDeviceId: string | null;
  contentType: string; createdAt: string; messageCreatedAt: string;
}
```
Models an entry in the `envelopes[]` array returned by `GET /sync` (`apps/backend/src/routes/sync.ts`).

### `apps/web/src/lib/realtime.ts:21-32` (`SyncedEnvelope`)
```ts
export interface SyncedEnvelope {
  id: string; messageId: string; conversationId: string; senderId?: string;
  senderDeviceId?: string | null; contentType?: string; ciphertext: string;
  sequenceNumber: number; deliveredAt?: string | null; createdAt: string;
}
```
A second, independent type modeling the same `GET /sync` envelope shape as `SyncEnvelope` above.

### `apps/web/src/hooks/useInboundPipeline.ts:20-29` (`NewMessageMeta`)
```ts
interface NewMessageMeta {
  id: string; conversationId: string; senderId: string; senderDeviceId: string | null;
  contentType: string; sequenceNumber: number; createdAt: string; unavailable?: boolean;
}
```
Models socket `new_message`.

**Backend shape these are all meant to track:** the `messages` Drizzle table (`apps/backend/src/db/schema.ts:113-136`) — `{ id, conversationId, senderId, senderDeviceId, contentType, ciphertext, fileId, editsMessageId, createdAt, deletedAt }` — plus, where applicable, `serializeMessage()`'s normalization (`ciphertext: string | null`, optional `unavailable: true`, `deletedAt`/`envelopes` stripped). Discrepancies: see [DRIFT-1](#drift-1-sequencenumber-is-typed-everywhere-but-never-sent), [DRIFT-6](#drift-6-fileid-and-editsmessageid-are-sent-but-never-typed), [DRIFT-7](#drift-7-message_deleted-payload-differs-between-rest-and-socket).

---

## Conversation

### `apps/web/src/app/conversations/[id]/page.tsx:44-49`
```ts
type Conversation = { id: string; type: 'dm' | 'group'; name?: string | null; members?: Member[] };
```
Models `GET /conversations/:id`.

### `apps/web/src/components/conversations/ConversationListSidebar.tsx:34-42`
```ts
interface Conversation {
  id: string; type: 'dm' | 'group'; name?: string | null; createdAt?: string;
  members?: Member[]; messages?: Message[]; unreadCount?: number;
}
```
Models the array returned by `GET /conversations` (see [`api-conversations.md`](../../backend/docs/api-conversations.md#get-conversations)).

**Backend shape:** `conversations` table (`apps/backend/src/db/schema.ts:41-47`) plus, on the list route, the aggregated `isMuted`, `isArchived`, `messageCount`, `unreadCount` fields computed in `apps/backend/src/routes/conversations.ts:167-173`. Discrepancy: see [DRIFT-8](#drift-8-messagecount-is-sent-but-not-typed-on-the-frontend).

---

## ConversationMember / Member

### `apps/web/src/app/conversations/[id]/page.tsx:17-24`, `ConversationListSidebar.tsx:19-26`, `ConversationHeader.tsx:6-13` (all three define an equivalent nested shape)
```ts
type Member = { user?: { id?: string; username?: string | null; avatarUrl?: string | null; wallets?: Wallet[] } };
```
Models the `members[]` array embedded in `GET /conversations` and `GET /conversations/:id` (the relational `with: { members: { with: { user: { with: { wallets } } } } }` include in `apps/backend/src/routes/conversations.ts:24-32`).

**Note:** this nested `{ user: {...} }` shape is *not* what `GET /conversations/:id/members` returns — that route flattens the member/user fields into one object and adds `primaryWalletAddress`. See [DRIFT-5](#drift-5-get-conversationsidmembers-response-shape-has-no-matching-frontend-type) — no frontend type or caller for that flattened shape currently exists in `apps/web`.

---

## User

### `apps/web/src/app/app/profile/page.tsx:18-23` (`UserProfile`)
```ts
type UserProfile = { id: string; username: string | null; avatarUrl: string | null; wallets: Wallet[] };
```
Models `GET /users/me` and `PATCH /users/me`.

### `apps/web/src/app/conversations/[id]/page.tsx:51-56` (`CurrentUser`)
```ts
type CurrentUser = { id: string; username: string | null; avatarUrl: string | null; wallets: Wallet[] };
```
A second, structurally identical type for the same endpoint, defined independently in a different file.

**Backend shape:** `apps/backend/src/routes/users.ts:93-103` also sends `presenceVisible` and `createdAt` on `GET /users/me`, neither of which any frontend `User`-shaped type declares. See [DRIFT-9](#drift-9-users-me-sends-presencevisible-and-createdat-which-no-frontend-type-declares).

---

## Device

### `apps/web/src/app/app/devices/page.tsx:8-17`
```ts
type Device = {
  id: string; identityPublicKey: string; deviceName: string | null;
  platform: 'web' | 'ios' | 'android' | null; lastSeenAt: string | null;
  isRevoked: boolean; createdAt: string; current: boolean;
};
```
Models `GET /devices` and `DELETE /devices/:id`.

### `apps/web/src/lib/crypto/types.ts:48-52` (`DevicePublicKey`)
```ts
export interface DevicePublicKey { id: string; userId: string; identityPublicKey: string; }
```
Models `GET /user-devices/:id/public-key`.

### `apps/web/src/lib/crypto.ts:22-27` (`DeviceRecord`)
```ts
export interface DeviceRecord { id: string; identityPublicKey: string; }
```
Models an entry in the `devices[]` array from `GET /conversations/:id/devices` (see [`api-conversations.md`](../../backend/docs/api-conversations.md#get-conversationsiddevices)).

**Backend shape:** `devices` table (`apps/backend/src/db/schema.ts`). `GET /devices` (`apps/backend/src/routes/devices.ts:76-88`) actually returns `revokedAt: Date | null` and `oneTimePreKeysRemaining`, not `isRevoked`. See [DRIFT-2](#drift-2-devices-declares-isrevoked-but-the-backend-sends-revokedat).

---

## TokenTransfer

**No dedicated frontend type exists** anywhere under `apps/web/src` for `POST`/`GET /conversations/:id/transfers`. The only `tokenTransfer`-shaped object in the frontend (`apps/web/src/app/app/page.tsx:15-19`, `{ amount: string; token: string; txHash: string }`) is hardcoded demo `useState` seed data, not wired to any fetch call — see [Dead/demo code not covered by this doc](#deaddemo-code-not-covered-by-this-doc).

**Backend shape:** `tokenTransfers` table (`apps/backend/src/db/schema.ts`), returned as-is by `apps/backend/src/routes/conversations.ts:646,681`. Since no frontend type exists yet, there is nothing to compare — this is a gap, not a drift (see [Follow-ups](#follow-ups-to-file-as-separate-issues) item 1).

---

## TreasuryProposal / Proposal

### `apps/web/src/components/treasury/ProposalCard.tsx:9-23` (real, wired to the backend via `apps/web/src/app/app/treasury/page.tsx`)
```ts
export type ProposalStatus = 'active' | 'approved' | 'rejected' | 'executed' | 'expired';
export interface Proposal {
  id: string; proposalId: string; status: ProposalStatus;
  approvalsCount: number; rejectionsCount: number;
  recipient: string | null; amount: string | null; token: string | null;
  threshold: number; hasVoted: boolean; myVote: 'approve' | 'reject' | null;
}
```
Models `GET /treasury/proposals`, and the socket `treasury_proposal_updated` event (partially).

**Backend shape:** `treasuryProposals` table + `treasuryProposalStatusEnum` (`'active' | 'approved' | 'rejected' | 'executed' | 'expired'`), matches this type's `ProposalStatus` union. However, `apps/backend/src/services/stellarListener.ts:183,189,197` reads `row.onChainId` when emitting `treasury_proposal_updated` — a column that does not exist on the `treasuryProposals` table (it has `proposalId: text`, not `onChainId`). This is a backend-side bug independent of the frontend type, but it means the socket event this `Proposal` type partially models may not fire correctly at runtime. Flagged as a follow-up, not fixed here (see [Follow-ups](#follow-ups-to-file-as-separate-issues) item 2).

### Two additional, non-canonical `Proposal`/`ProposalStatus` definitions exist and should **not** be used as the reference:
- `apps/web/src/components/ui/ProposalCard.tsx:5-15` — `ProposalStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired'` (uses `'pending'` where the DB enum uses `'active'`) plus an `expiryLedger: number` field the backend never sends. Only referenced by its own test file; not used by any real page.
- `apps/web/src/app/app/proposals/page.tsx:5-15` — a fully hardcoded demo `Proposal` with `status: 'Active' | 'Succeeded' | 'Defeated'`, unrelated to the real enum. No network calls. See [Dead/demo code](#deaddemo-code-not-covered-by-this-doc).

---

## File / Upload

### `apps/web/src/lib/fileEncryption.ts:58-68`
```ts
export interface PresignedUploadResponse { fileId: string; uploadUrl: string; }
export interface PresignedDownloadResponse { url: string; }
```
`PresignedDownloadResponse` correctly matches `GET /files/:fileId` (`apps/backend/src/routes/files.ts:15,59` — `res.json({ url: presignedUrl })`).

`PresignedUploadResponse` is intended to model the upload-slot request, but see [DRIFT-3](#drift-3-file-upload-request-targets-a-route-and-body-shape-that-dont-match-the-backend) — the request this type's caller sends doesn't reach the route it's shaped for.

---

## PushSubscription

No dedicated response type exists — `apps/web/src/hooks/usePushSubscription.ts` only types the *request* body (`{ endpoint, keys }`, from the native `PushSubscription.toJSON()`) and never types the `POST /push/subscriptions` response (`{ success: true }` on the backend, or a `204` on `DELETE`). Gap, not drift — see [Follow-ups](#follow-ups-to-file-as-separate-issues) item 1.

---

## Socket.IO event envelope

### `apps/web/src/lib/realtime.ts:8-13`
```ts
export interface EventEnvelope<T> { eventId: string; type: string; timestamp: number; payload: T; }
```
Matches `EventEnvelopeSchema` in `apps/backend/src/lib/eventEnvelope.ts:31-36` field-for-field. **No drift** — this is the one type in this document that tracks its backend counterpart exactly. Note it only covers the outbound `dispatch` envelope wrapper (`apps/backend/src/socket/dispatcher.ts`); it is not used for the many plain `socket.emit(...)` events listed under [Message](#message) above, which bypass the envelope entirely.

---

## Dead/demo code not covered by this doc

These "types" don't model any real API response and are excluded from the comparison above rather than flagged as drift:
- `apps/web/src/app/app/page.tsx` (`/app` route) — hardcoded `useState` seed messages, no `fetch`/socket calls.
- `apps/web/src/app/app/proposals/page.tsx` — hardcoded seed proposals with a `status` union that doesn't match the real enum.
- `apps/web/src/components/ui/ProposalCard.tsx` — separate, unused-in-production `ProposalStatus`/`Proposal` shape.
- `apps/web/src/app/app/treasury/page.tsx`'s `assets` and `transactions` arrays (lines 17-72) — hardcoded demo data, unrelated to `tokenTransfers` or any real endpoint.

---

## Known discrepancies (drift)

These are documented as **known issues to file separately** per the acceptance criteria for this doc — nothing below has been fixed as part of writing this document.

### DRIFT-1: `sequenceNumber` is typed everywhere but never sent
Seven frontend types (`MessageEnvelopeEvent`, `DeviceEnvelopeEvent`, `SyncEnvelope`, `SyncedEnvelope`, `NewMessageMeta`, the `app/app/conversations/[id]` `Message`, `ChatMessage`) declare a `sequenceNumber: number` field. The backend deliberately dropped a per-conversation sequence counter (see the doc comment at `apps/backend/src/db/schema.ts:107-112`), so `message_envelope`, `new_message`, and `GET /sync`'s `envelopes[]` never include this key. Frontend code defends with `msg.sequenceNumber ?? 0` (e.g. `apps/web/src/lib/crypto/processEnvelope.ts:76`'s `sortBySequenceNumber`, `apps/web/src/hooks/useInboundPipeline.ts:133`), meaning ordering silently collapses to `0` for every live/synced message. This is a real, currently-silent correctness bug in message ordering, not just a stale type.

### DRIFT-2: `Device.isRevoked` vs. backend's `revokedAt`
`apps/web/src/app/app/devices/page.tsx:8-16`'s `Device` type declares `isRevoked: boolean`, but `GET /devices` (`apps/backend/src/routes/devices.ts:76-88`) sends `revokedAt: Date | null`, never `isRevoked`. On initial page load, `device.isRevoked` is `undefined`/falsy for every device — including already-revoked ones — until the frontend sets it locally after a same-session `DELETE`. `oneTimePreKeysRemaining`, also sent by the backend, isn't declared by this type either.

### DRIFT-3: file-upload request targets a route and body shape that don't match the backend
`apps/web/src/lib/fileEncryption.ts:146` (`requestPresignedUpload`) calls `POST /files/presign-upload`, but the backend's upload-slot route is `POST /uploads` (`apps/backend/src/routes/uploads.ts:39`). Body shapes also differ: backend's `RequestSlotSchema` expects `{ conversationId, size, mimeType, sha256, isThumbnail? }` (`uploads.ts:30-36`) and responds `{ fileId, uploadUrl }`; the frontend sends `{ fileName, mimeType, sizeBytes }` — missing `conversationId`/`sha256`, and `sizeBytes` instead of `size`. This path appears non-functional as written.

### DRIFT-4: `GET /sync` cursor type and param name mismatch
Backend `apps/backend/src/routes/sync.ts` reads `deviceId`, `cursor` (an opaque string `"<epochMillis>:<uuid>"`) and `limit`, and returns `nextCursor` as a string or `null`. The frontend sends `sinceSequence` (a `number`) instead of `cursor` in both `apps/web/src/lib/realtime.ts:140-142` and `apps/web/src/hooks/useInboundPipeline.ts:188-191` — a param the backend never reads, so every sync call restarts from the beginning of the retention window rather than resuming. Both call sites also type `nextCursor` as `number` and do `Math.max(cursor, data.nextCursor ?? cursor)` against what is actually a string, which would produce `NaN`.

### DRIFT-5: `GET /conversations/:id/members` response shape has no matching frontend type
The route returns a flattened `{ id, username, avatarUrl, primaryWalletAddress, joinedAt }` per member (`apps/backend/src/routes/conversations.ts:70-81`), where `id` is the *user* id. Every frontend `Member` type instead expects the nested `{ user: { id, username, avatarUrl, wallets: [...] } }` shape that `GET /conversations`/`GET /conversations/:id` return via their relational include. No `fetch` call to `.../members` was found anywhere in `apps/web/src` — the endpoint currently has no frontend consumer at all.

### DRIFT-6: `fileId` and `editsMessageId` are sent but never typed
Raw `messages`-row emits (`new_message`, and the row underlying `message_envelope`) include `fileId` and `editsMessageId` (`apps/backend/src/db/schema.ts:128-129`). No frontend `Message`/`ChatMessage`/`NewMessageMeta` type declares either field, so file-attachment and edit-chain metadata delivered over the socket is invisible to code typed against these interfaces (present on the object at runtime, untyped and unread).

### DRIFT-7: `message_deleted` payload differs between REST and socket
REST delete (`apps/backend/src/routes/messages.ts:167-170`) emits `{ messageId, conversationId }`; the socket `delete_message` path (`apps/backend/src/socket/messaging.ts:600-601`) emits `{ messageId }` only, with no `conversationId`. No frontend listener for `message_deleted` currently exists, so this is latent rather than actively broken — but any future listener keyed on `conversationId` would silently break for the socket path.

### DRIFT-8: `messageCount` is sent but not typed on the frontend
`GET /conversations` includes `messageCount` per conversation (`apps/backend/src/routes/conversations.ts:171`), alongside `unreadCount`. `apps/web/src/components/conversations/ConversationListSidebar.tsx:34-42`'s `Conversation` type declares `unreadCount` but not `messageCount`.

### DRIFT-9: `/users/me` sends `presenceVisible` and `createdAt` which no frontend type declares
`apps/backend/src/routes/users.ts:93-103` includes both fields on `GET /users/me`; neither `UserProfile` (`apps/web/src/app/app/profile/page.tsx:18-23`) nor `CurrentUser` (`apps/web/src/app/conversations/[id]/page.tsx:51-56`) declares them.

### DRIFT-10: `send_message` content/ciphertext field aliasing is legacy cruft
The socket `send_message` handler (`apps/backend/src/socket/messaging.ts:90-106`) accepts both `content` and `ciphertext` (`effectiveCiphertext = ciphertext ?? content`), but `POST /messages`'s `SendMessageSchema` only accepts `ciphertext`. The frontend's own `sendMessage()` (`apps/web/src/app/app/conversations/[id]/page.tsx:265-271`) only ever sends `ciphertext`, yet `normaliseMessage()` in the same file (lines 70-88) still reads `msg.content ?? msg.ciphertext` defensively, suggesting a stale code path from before the field was renamed. Worth cleaning up but not itself a type-correctness bug for current traffic.

---

## Follow-ups to file as separate issues

1. Add frontend types for `TokenTransfer` (`GET`/`POST /conversations/:id/transfers`) and the `POST /push/subscriptions` response — currently untyped gaps, not drift, but should be filled in for completeness.
2. Fix `apps/backend/src/services/stellarListener.ts` reading `row.onChainId`, a column that doesn't exist on `treasuryProposals` (should be `proposalId`) — backend bug, independent of any frontend type.
3. Resolve DRIFT-1 through DRIFT-10 above. DRIFT-1 (sequence numbers) and DRIFT-4 (sync cursor) are the highest priority — both are live correctness bugs (message ordering and sync resumption), not just stale typings.
4. Decide whether `GET /conversations/:id/members`'s flattened response shape (DRIFT-5) should be adopted by the frontend, or whether the route itself should be removed since nothing consumes it.
