# React hooks reference

Reference for the hooks in [src/hooks/](../src/hooks/):

| Hook                                              | Purpose                                                        | Owner model              |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| [`useSocket`](#usesocket)                         | Opens and owns one Socket.IO connection                        | One per connection       |
| [`useInboundPipeline`](#useinboundpipeline)       | Decrypts inbound envelopes into renderable messages            | Single owner             |
| [`useMessageHistory`](#usemessagehistory)         | Paginated message list over the `message_history` socket event | Single owner             |
| [`useLocalSearch`](#uselocalsearch)               | Debounced query state over the local encrypted search index    | Safe to mount repeatedly |
| [`useMessageSearchIndex`](#usemessagesearchindex) | Decrypts and indexes messages into the local search store      | Single owner             |
| [`usePushSubscription`](#usepushsubscription)     | Service-worker registration and Web Push subscription          | Effectively single owner |

Every hook here is in a `'use client'` module. See [Message pipeline](concepts-message-pipeline.md), [Local search](concepts-local-search.md), [Push subscription](concepts-push-subscription.md), and [WebSocket client](api-websocket-client.md) for the surrounding architecture.

---

## `useSocket`

[src/hooks/useSocket.ts](../src/hooks/useSocket.ts)

Creates a Socket.IO connection, drives resume/sync on connect, and acknowledges delivery of inbound envelopes.

### Arguments

| Argument | Type             | Notes                                                                          |
| -------- | ---------------- | ------------------------------------------------------------------------------ |
| `token`  | `string \| null` | The session JWT. `null` yields `null` — the hook is safe to call before login. |

### Returns

`Socket | null` — the live client, or `null` while `token` is `null`.

The socket is built in a `useMemo` keyed on `token`. A changed token tears down the old socket and builds a new one; a re-render with the same token returns the same instance.

Connection options: `auth: { token, deviceId }` where `deviceId` comes from `getRealtimeDeviceId(token)`, `transports: ['websocket']`, `reconnection: true`. The URL is `NEXT_PUBLIC_SOCKET_URL`, falling back to `NEXT_PUBLIC_BACKEND_URL`, then `http://localhost:3001`.

### Side effects

On `connect` (and immediately if the socket is already connected), it runs `resumeThenSync()`:

1. Emits `resume` with `{ lastEventId: getResumeCursor(token) }`.
2. Awaits `runSocketSync(socket, token)`.

It also registers three listeners:

| Event              | Handler                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `resume_complete`  | Stores `lastEventId` as the new resume cursor; re-runs sync when `syncRequired` is set.                          |
| `ephemeral_replay` | Advances the resume cursor and re-dispatches the replayed event locally via `replaySocketEvent`.                 |
| `message_envelope` | Emits `message_delivered` back to the server with the conversation, message, envelope, and sequence identifiers. |

Cursors are persisted through [src/lib/realtime.ts](../src/lib/realtime.ts), which reads and writes `localStorage` under `clicked.socket.*` keys.

### Cleanup

The effect sets a `closed` flag (so an in-flight `resumeThenSync` stops), removes all four listeners, and calls `socket.disconnect()`. Unmounting therefore closes the connection.

### Mounting

**Each call to `useSocket` owns its own connection.** There is no module-level singleton and no context — two components calling `useSocket(token)` open two independent WebSockets to the gateway, each with its own resume cycle and each acknowledging delivery separately. The app does this today: [treasury/page.tsx](../src/app/app/treasury/page.tsx), [`conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx), and [ConversationListSidebar.tsx](../src/components/conversations/ConversationListSidebar.tsx) each mount one.

That works, but it is not free: connection count scales with mount count, and because all instances share the same `localStorage` resume cursor, concurrent sockets can advance the cursor past events another instance has not processed. Prefer passing an existing socket down as a prop over mounting a second `useSocket` in the same subtree.

---

## `useInboundPipeline`

[src/hooks/useInboundPipeline.ts](../src/hooks/useInboundPipeline.ts)

The inbound decryption and render pipeline: receives envelopes live or through catch-up sync, decrypts and verifies them, and exposes messages ordered by sequence number.

### Arguments

Single options object:

| Field            | Type             | Notes                                                                                                   |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `socket`         | `Socket \| null` | Normally the return value of `useSocket`. `null` is tolerated — live listeners are simply not attached. |
| `token`          | `string \| null` | Session JWT, used for the sync fetch and for key lookup.                                                |
| `conversationId` | `string`         | Every inbound event for a different conversation is ignored.                                            |

### Returns

```ts
{ messages: InboundMessage[]; syncing: boolean }
```

`messages` is memoized and sorted by `sequenceNumber`. `syncing` is `true` while the catch-up fetch loop is running.

A message can appear with `status: 'pending'` (metadata arrived, ciphertext has not), `status: 'unavailable'` with `unavailableReason: 'pre-link'` (sent before this device was linked, so it is undecryptable by design), or fully decrypted.

### Side effects

**Live delivery.** While `socket` is non-null, it listens for:

- `message_envelope` — a complete envelope; decrypted immediately.
- `device_envelope` — ciphertext only; held in a `pendingCiphertext` ref until matching metadata arrives.
- `new_message` — metadata only; held in a `pendingMeta` ref, then joined with any pending ciphertext.

The two-ref join exists because ciphertext and metadata arrive as separate events with no ordering guarantee. Whichever lands second triggers the decrypt.

**Catch-up sync.** A second effect runs `runSync()` whenever `token` or `conversationId` changes: it reads the E2EE device id from the token and pages `GET /sync?deviceId=…&sinceSequence=…` until `hasMore` is false, feeding each envelope for this conversation through the same decrypt path. The cursor lives in a ref and survives re-renders.

**De-duplication.** A `processing` ref holds message ids currently being decrypted, so the same message arriving twice (live and again via sync) is decrypted once. Results are merged into a `Map` keyed by message id via `mergeInboundMessage`.

Decryption runs in [src/lib/crypto/processEnvelope.ts](../src/lib/crypto/processEnvelope.ts) and touches WebCrypto and IndexedDB-backed key stores.

### Cleanup

The live-delivery effect removes all three listeners on teardown or when `socket`/`conversationId` changes. It does **not** disconnect the socket — that belongs to `useSocket`.

The sync effect has **no cancellation**. An in-flight `runSync` for a previous `conversationId` keeps paging after the id changes; per-envelope conversation filtering keeps stale results out of state, but the requests continue. Rapidly switching conversations can leave several overlapping sync loops running.

### Mounting

**Single owner per conversation.** Each instance keeps its own message map and its own sync cursor, so two instances mounted on the same `conversationId` decrypt everything twice, run two independent paging loops against `/sync`, and duplicate all the crypto work. Mount it once, at the component that owns the thread, and pass `messages` down.

---

## Ordering: `useSocket` before `useInboundPipeline`

`useInboundPipeline` does not create a connection — it attaches listeners to one it is handed. The two hooks must therefore be called in that order in the same component:

```tsx
const socket = useSocket(token); // 1. must come first
const { messages } = useInboundPipeline({
  socket, // 2. consumes what step 1 produced
  token,
  conversationId,
});
```

This is what [`conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx) does. Three things depend on the ordering:

**Data dependency.** `socket` is an argument to `useInboundPipeline`. Calling the pipeline first means passing `null`, and the pipeline attaches no listeners at all until a later render supplies the socket.

**Effect ordering within the component.** React runs effects in the order the hooks were called. `useSocket`'s effect runs first and registers the `connect` handler; `useInboundPipeline`'s effect runs immediately after and registers `message_envelope`, `device_envelope`, and `new_message`. Because the socket is created fresh in `useMemo` and connects asynchronously, the `connect` event — and therefore the `resume` emit and the server's replay of buffered events — cannot fire until after the pipeline's listeners are attached. Reversing the order would mean the pipeline attaches its listeners on a socket that may already be mid-replay, and replayed envelopes would be dropped.

**Teardown ordering.** React runs cleanups in the same order. `useSocket`'s cleanup disconnects; the pipeline's cleanup only detaches handlers, so it does not matter that it runs after. The pipeline must never call `disconnect()` itself — doing so would close a connection other consumers of the same socket still hold.

The same rule applies to `useMessageHistory`, which likewise consumes a socket it does not own.

---

## `useMessageHistory`

[src/hooks/useMessageHistory.ts](../src/hooks/useMessageHistory.ts)

Client side of the backend `message_history` socket event: keeps a paginated, oldest-first message list and appends live arrivals.

### Arguments

| Field            | Type             | Notes                                            |
| ---------------- | ---------------- | ------------------------------------------------ |
| `socket`         | `Socket \| null` | Not owned by this hook.                          |
| `conversationId` | `string`         | Changing it resets all state for the new thread. |

### Returns

```ts
{
  messages: ChatMessage[];      // oldest-first
  loadingOlder: boolean;
  hasReachedStart: boolean;     // server returned an empty page
  loadOlder: () => void;        // fetch one page older than the current oldest
}
```

The return object is memoized, so it is stable between renders when nothing changed.

### Side effects

- Listens for `message_history` acks, ignoring those for other conversations. New pages are filtered against the ids already in state, sorted oldest-first, and prepended. An empty page or `done: true` sets `hasReachedStart`.
- Listens for `new_message` and appends, skipping ids already present. `content` is taken from `ciphertext` when present, falling back to `content`.
- `loadOlder()` emits `message_history` with `{ conversationId, before: <oldest known id> }`. It no-ops while `loadingOlder` is set or once `hasReachedStart` is true.
- Calls `useMessageSearchIndex(messages)` internally, so every message it holds is decrypted and pushed into the local search index. **This is a side effect of mounting the hook**, and it is why mounting it twice is expensive.

All per-conversation state lives in one state object, reset by comparing `conversationId` against the previous render's value during render — React's documented pattern for resetting state on a prop change, no effect involved. De-duplication is keyed on message id, which is what lets consumers use `id` as a React key safely.

### Cleanup

Both listener effects remove their handlers on teardown or when `socket`/`conversationId` changes. There is no cleanup for `loadOlder` — a request in flight when the hook unmounts simply has no listener left to receive its ack.

### Mounting

**Single owner per conversation.** Two instances both listen for `message_history` and both handle every ack, so one `loadOlder()` call fills both lists; more importantly, both re-index the same messages through `useMessageSearchIndex`, duplicating decryption work.

---

## `useLocalSearch`

[src/hooks/useLocalSearch.ts](../src/hooks/useLocalSearch.ts)

Debounced query state over the local encrypted search index.

### Arguments

Options object, all optional:

| Field            | Type     | Default | Notes                                            |
| ---------------- | -------- | ------- | ------------------------------------------------ |
| `conversationId` | `string` | —       | Scopes results; omit to search everything.       |
| `debounceMs`     | `number` | `180`   | Delay between the last keystroke and the search. |
| `minQueryLength` | `number` | `2`     | Shorter queries clear results without searching. |

### Returns

```ts
{
  query: string;
  setQuery: (q: string) => void;
  hits: SearchHit[];
  total: number;
  loading: boolean;
  error: string | null;
  clear: () => void;
}
```

Note that the returned object is **not** memoized — it is a fresh object every render. Consumers should destructure rather than pass it whole into a dependency array.

### Side effects

An effect debounces `query` with `setTimeout` and calls `search()` from [src/lib/search/searchClient.ts](../src/lib/search/searchClient.ts), which posts to the search Web Worker. The worker is created lazily by the search client on first use.

Out-of-order results are handled with a monotonic run counter (`abortRef`): each run takes an id, and a resolved search whose id is no longer current is discarded. The request itself is not aborted — only its result is ignored.

### Cleanup

The debounce effect clears its timeout, so a pending search is cancelled when the query changes or the component unmounts. Nothing else needs teardown.

### Mounting

**Safe to mount more than once.** State is entirely local, it owns no connection and no listener, and the Web Worker behind `searchClient` is a module-level singleton shared by all callers. Several independent search boxes can coexist; each keeps its own query and results.

---

## `useMessageSearchIndex`

[src/hooks/useMessageSearchIndex.ts](../src/hooks/useMessageSearchIndex.ts)

Decrypts messages and writes them into the local search store. Called internally by `useMessageHistory`.

### Arguments

`messages: IndexableMessage[]` — id, conversation, sender, optional `senderDeviceId` / `senderIdentityPublicKey`, `ciphertext` (or legacy `content`), `contentType`, `createdAt`, and `sequenceNumber`.

### Returns

Nothing. It exists purely for its side effect.

### Side effects

For each message it calls `decryptMessageText(ciphertext, senderDeviceId, senderIdentityPublicKey)` from [src/lib/crypto/messageCrypto.ts](../src/lib/crypto/messageCrypto.ts), skipping anything that does not decrypt, then hands the batch to `indexMessages()`. That writes the rows encrypted-at-rest into IndexedDB and updates the Web Worker's inverted index. Failures are logged with `console.warn` and swallowed — indexing never breaks rendering.

The effect is keyed on the `messages` array **identity**, not its contents. A caller that rebuilds the array on every render re-decrypts the whole list every render; `useMessageHistory` avoids this by keeping the array stable in state.

### Cleanup

A `cancelled` flag set in the cleanup prevents a completed batch from being written after unmount. Decryption already in progress is not aborted — the results are just discarded.

### Mounting

**Single owner per message set.** Mounting it twice over the same messages doubles the decryption work for an identical result. `indexMessages` is idempotent, so the outcome is correct; the cost is not.

---

## `usePushSubscription`

[src/hooks/usePushSubscription.ts](../src/hooks/usePushSubscription.ts)

Registers the service worker and manages the Web Push subscription.

### Arguments

`token: string | null` — the session JWT. `null` skips the VAPID fetch and disables subscribing.

### Returns

```ts
{
  permission: NotificationPermission; // 'default' | 'granted' | 'denied'
  subscribed: boolean; // true once posted to the server
  requestSubscription: () => Promise<void>;
}
```

`requestSubscription` is safe to call repeatedly: it reuses an existing `PushSubscription` when one exists rather than creating a second.

### Side effects

Three effects, each guarded:

1. **Service worker registration** — bails out when `window` is undefined or when `serviceWorker`/`PushManager` are unavailable, then registers `/sw.js` and stores the registration.
2. **VAPID key fetch** — with a token, calls `GET /push/vapid-public-key` through `fetchVapidPublicKey` (also exported standalone). The public key comes from the backend rather than a build-time env var so it cannot drift from the private key the backend signs with. Returns `null` on any failure, which leaves push registration skipped rather than broken.
3. **Existing-subscription reuse** — once registration, token, and VAPID key are all present and permission is already `granted`, it fetches any existing subscription, marks `subscribed`, and re-POSTs it to `/push/subscriptions` (idempotent), so the server is re-synced after a reinstall or a database restore.

`requestSubscription()` calls `Notification.requestPermission()`, returns early unless the result is `granted`, then reuses or creates a subscription with `applicationServerKey` derived from the base64url VAPID key, POSTs it, and sets `subscribed`.

### Cleanup

Each effect uses an `active` flag cleared on teardown, so a resolved promise cannot `setState` after unmount. Nothing is unregistered or unsubscribed — the service worker and the push subscription intentionally outlive the component, which is the point of push.

### Mounting

**Effectively single owner.** Every instance registers `/sw.js` (the browser deduplicates this, so it is not harmful) and each keeps its own `permission`/`subscribed` state, which then diverges: one instance calling `requestSubscription` does not update another's `subscribed`. Multiple instances can also race to POST the same subscription — harmless, since the endpoint is idempotent, but wasteful. Mount it once, near the root; [PushPermissionPrompt.tsx](../src/components/PushPermissionPrompt.tsx) is the single consumer today.

---

## SSR constraint

Every hook in this directory is in a `'use client'` module, but in the Next.js App Router that only means the component hydrates on the client — it is still **pre-rendered on the server**. Render-phase code runs in Node, where `window`, `navigator`, `localStorage`, `IndexedDB`, `Worker`, and `crypto.subtle` are absent or behave differently.

The rule this codebase follows:

> Anything touching `window`, IndexedDB, WebCrypto, or a Web Worker belongs in an effect, or behind an explicit `typeof window !== 'undefined'` guard. Effects never run during server render, which is what makes them safe.

How each hook satisfies it:

| Hook                    | Browser API                               | How it is kept off the server                                                                                                                         |
| ----------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useInboundPipeline`    | WebCrypto, IndexedDB, `fetch`             | All decryption and sync run inside effects and callbacks.                                                                                             |
| `useMessageHistory`     | Socket listeners                          | Listener registration and emits are inside effects and callbacks.                                                                                     |
| `useLocalSearch`        | Web Worker                                | The worker is created lazily on the first search, from an effect.                                                                                     |
| `useMessageSearchIndex` | IndexedDB, WebCrypto                      | The whole body is inside a `useEffect`.                                                                                                               |
| `usePushSubscription`   | `navigator.serviceWorker`, `Notification` | Effects, plus a `typeof window !== 'undefined' && 'Notification' in window` guard on the lazy `useState` initializer, which _does_ run during render. |

`useSocket` is the exception worth knowing about: it constructs the Socket.IO client inside a `useMemo`, which runs during render — on the server too, when `token` is non-null. In practice server renders have no token, so the memo short-circuits to `null` and no connection is attempted. **Do not pass a server-resolved token into `useSocket`.** If a route ever needs one, gate the subtree behind a mounted flag or a `next/dynamic` import with `ssr: false`; moving the connection into an effect would be the more robust fix.

The same caution applies to `getRealtimeDeviceId`, which reads `localStorage`. It guards with `typeof window === 'undefined'` and falls back to the device id decoded from the JWT claims, so it is safe to call in either environment — but it returns different values on server and client, which is a hydration-mismatch source if its result is ever rendered.
