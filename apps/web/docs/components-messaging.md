# Messaging components

Source: `apps/web/src/components/messaging/`

- `MessageThread.tsx`
- `InboundMessageRow.tsx`
- `EncryptedThumbnail.tsx`
- `UnavailableMessagePlaceholder.tsx`

## MessageThread

`MessageThread` is the scrollable message list: infinite-scroll-to-load-older, scroll-position
preservation across prepends, and a live typing indicator.

**Props** (`MessageThreadProps`):

| Prop | Type | Purpose |
|---|---|---|
| `messages` | `ChatMessage[]` | Messages to render, oldest-first (see `useMessageHistory`'s `ChatMessage`). |
| `loadingOlder` | `boolean` | Shows a `Spinner` at the top while an older page is being fetched. |
| `hasReachedStart` | `boolean` | Shows "No more messages" (or the empty state) once the server has no earlier page. |
| `onLoadOlder` | `() => void` | Called when the user scrolls within `triggerDistance` of the top. |
| `triggerDistance?` | `number` (default `120`) | Pixel threshold from the top that re-arms `onLoadOlder`. |
| `renderMessage?` | `(message: ChatMessage) => React.ReactNode` | Row renderer override; falls back to the internal `DefaultMessageRow`. |
| `socket?` | `Socket \| null` | Socket.IO client used to listen for `typing_start` / `typing_stop` / `new_message`. |
| `currentUserId?` | `string` | Suppresses the typing indicator for the local user. |
| `conversationId?` | `string` | Scopes typing events to the conversation currently open. |

Behavior notes:

- A `useLayoutEffect` diffs `messages[0].id` against the previous render and adds the resulting
  `scrollHeight` delta to `scrollTop`, so prepending older messages doesn't visually jump the view.
- Typing users are tracked in a `Set<string>`, each with its own 3s auto-hide timer (cleared early
  by `typing_stop` or by any `new_message` for the conversation).
- `messages.map` uses `message.id` as the React key — `useMessageHistory` dedupes by id specifically
  so this key is always unique (see that hook's comments).
- The built-in `DefaultMessageRow` (used only when `renderMessage` is not supplied) reads
  `message.content || message.ciphertext || ''` directly — it does **not** call into the
  `InboundMessage`/decrypt pipeline described below. It is a plain, non-E2EE-aware fallback row.

**Where it's rendered:** no current call site imports `MessageThread` outside its own file — it is
not yet wired into `apps/web/src/app/app/conversations/[id]/page.tsx`, which currently renders its
own inline message list (see below) rather than using this component.

## InboundMessageRow

Renders a single E2EE-decrypted `InboundMessage` as a chat bubble, switching on `message.status`.

**Props** (`InboundMessageRowProps`):

| Prop | Type | Purpose |
|---|---|---|
| `message` | `InboundMessage` (from `@/lib/crypto/types`) | The row's data — see "Message row states" below. |
| `isSelf` | `boolean` | Right-aligns the bubble and swaps to the accent-colored "self" style. |
| `senderName?` | `string` | Shown above the bubble for messages from others (not shown when `isSelf`). |

Render branches, in order:

1. `status === 'decrypted' && plaintext` → the bubble with `message.plaintext`.
2. `status === 'unavailable' && unavailableReason` → `<UnavailableMessagePlaceholder reason={...} />`.
3. otherwise (i.e. `status === 'pending'`, or `'unavailable'` with no reason set) → an italic
   "Decrypting…" placeholder.

**Where it's rendered:** like `MessageThread`, `InboundMessageRow` has no current importer outside
its own file. The live conversation page (`apps/web/src/app/app/conversations/[id]/page.tsx`)
implements an equivalent branch inline (see "Message row states" below) rather than using this
component — `InboundMessageRow` / `MessageThread` / `useInboundPipeline` appear to be the
newer/parallel E2EE-message-list implementation.

## EncryptedThumbnail

Renders an inline decrypted preview for an image/video attachment's thumbnail.

**Props** (`EncryptedThumbnailProps`):

| Prop | Type | Purpose |
|---|---|---|
| `thumbnail` | `FileMessagePayload['thumbnail']` | The `{ fileId, fileKey, iv, mimeType }` reference from a decrypted file message. |
| `authToken` | `string` | JWT sent when fetching the presigned download URL. |
| `apiBaseUrl` | `string` | Backend base URL for the download request. |
| `alt?` | `string` (default `'File thumbnail'`) | `<img>` alt text. |
| `className?` | `string` | Overrides the default `<img>` classes. |

**Decrypt-to-object-URL flow** (`useEffect` on `[thumbnail, authToken, apiBaseUrl]`):

1. Calls `decryptThumbnailToObjectUrl(thumbnail, authToken, apiBaseUrl)` from `@/lib/thumbnail`,
   which:
   - downloads + decrypts the thumbnail ciphertext via `downloadAndDecryptFile(...)` (AES-GCM,
     using `thumbnail.fileKey`/`thumbnail.iv`), producing a plaintext `Blob`;
   - calls `URL.createObjectURL(plainBlob)` and returns that URL (or `null` on any decrypt/download
     error, which it also `console.warn`s).
2. On resolution, `setObjectUrl(url)` swaps the skeleton for the real `<img src={objectUrl}>`.
3. On rejection, `setError(true)` renders a small "⚠️" placeholder box instead.

**Cleanup obligation:** the effect's cleanup function revokes the *current* `objectUrl` state
(`URL.revokeObjectURL(objectUrl)`) and sets a local `revoked` flag so an in-flight decrypt that
resolves after unmount/prop-change is ignored (`if (!revoked) setObjectUrl(url)`). Because
`objectUrl` is deliberately left out of the effect's dependency array (documented inline with an
`eslint-disable-next-line react-hooks/exhaustive-deps`), the revoke only happens once per
`[thumbnail, authToken, apiBaseUrl]` change/unmount rather than firing on every `objectUrl` update
— but it does mean the object URL created for state derived on the *previous* run of the effect is
the one revoked when the effect re-runs or the component unmounts, preventing the created blob URL
from leaking.

Loading/empty states: renders `null` if `thumbnail` is falsy; an animated skeleton `div` while
`objectUrl` is not yet set and no error has occurred; and the `<img>` once `objectUrl` resolves.

**Where it's rendered:** `apps/web/src/app/app/conversations/[id]/page.tsx`, inside the message
list, for any message where `message.filePayload` is set and `message.contentType` is `'image'` or
`'video'` — paired with a "Download {fileName}" button that calls `handleFileDownload(message)`.

## UnavailableMessagePlaceholder

A small, reusable "this message can't be shown as text" bubble, used for both legitimately
unavailable messages and decrypt failures.

**Props** (`UnavailableMessagePlaceholderProps`):

| Prop | Type | Purpose |
|---|---|---|
| `reason` | `UnavailableReason` (from `@/lib/crypto/types`) | Selects the copy shown; `'pre-link' \| 'undecryptable' \| 'verification-failed'`. |

Copy table (`REASON_COPY`):

| `reason` | Copy shown |
|---|---|
| `'pre-link'` | "Waiting for secure session — message from before this device was linked." |
| `'undecryptable'` | "Unable to decrypt this message." |
| `'verification-failed'` | "Message could not be verified." |

**The distinction it must preserve:** "no envelope for this device" is not the same failure as
"envelope exists but decryption/verification failed", and the component keeps them apart entirely
through the `reason` value it's handed — it does no inference of its own. The producing logic is
`apps/web/src/lib/crypto/processEnvelope.ts` (`processInboundEnvelope`):

- **Legitimately unavailable (`'pre-link'`):** when `envelope.senderDeviceId` is `null` —
  meaning this device was linked *after* the message was sent, so no per-device envelope was ever
  created for it — `processInboundEnvelope` returns `{ ...base, status: 'unavailable',
  unavailableReason: 'pre-link' }` *before* attempting any decryption at all. The same
  `unavailableReason: 'pre-link'` is also set directly by `useInboundPipeline.ts`'s `ingestMeta`
  when the backend flags a `new_message` payload's metadata as `meta.unavailable` — again short-
  circuiting before a decrypt attempt.
- **Decryption/verification actually failed (envelope exists):** when an envelope *is* present and
  `fetchSenderDevicePublicKey(...)` + `decryptAndVerifyEnvelope(...)` throws, the `catch` block sets
  `status: 'unavailable'` with `unavailableReason: unavailableReasonFromError(err)`, which maps:
  - `err instanceof VerificationFailedError` → `'verification-failed'` (signature check failed —
    thrown by `decryptAndVerifyEnvelope` in `apps/web/src/lib/crypto/decrypt.ts`),
  - `err instanceof DecryptError` (or anything else, as the catch-all) → `'undecryptable'`
    (decrypt itself failed, e.g. corrupted/mismatched key material),
  - note `PreLinkError` is also handled here (mapped to `'pre-link'`) since
    `decryptAndVerifyEnvelope` throws it when no session exists for the sender device — the same
    outward reason as the "no envelope at all" case above, but reached via a thrown error during an
    actual decrypt attempt rather than skipping decryption up front.

So the three `UnavailableReason` values are not synonyms for "can't read this message": `'pre-link'`
means "no session/envelope for this device — expected, not corruption"; `'undecryptable'` and
`'verification-failed'` both mean "an envelope existed and decrypting/verifying it failed."
`InboundMessageRow` and the conversation page both render this via `UnavailableMessagePlaceholder`
without collapsing the distinction — each `reason` gets its own copy.

Note the inline usage in `apps/web/src/app/app/conversations/[id]/page.tsx` currently hardcodes
`<UnavailableMessagePlaceholder reason="undecryptable" />` for any `message.unavailable` message,
rather than threading through the real reason from the backend/pipeline — so on that particular
page the pre-link vs. decrypt-failure distinction is not yet surfaced to the user, even though the
type (`UnavailableReason`) and the `processEnvelope.ts`/`useInboundPipeline.ts` pipeline do compute
it correctly for `InboundMessageRow` consumers.

## Message row states

Two parallel data models exist for a "message" in this codebase:

1. **`ChatMessage`** (`apps/web/src/hooks/useMessageHistory.ts`) — the plain shape used by
   `MessageThread`'s `DefaultMessageRow`. Fields: `id`, `conversationId`, `senderId`, `content`,
   `createdAt`, plus optional E2EE-ish fields `ciphertext?`, `contentType?`, `sequenceNumber?`. There
   is no `status` field — `DefaultMessageRow` just prints `content || ciphertext || ''` verbatim (see
   the `#185` comment in `MessageThread.tsx` noting the decryption shim currently passes ciphertext
   through as-is).

2. **`InboundMessage`** (`apps/web/src/lib/crypto/types.ts`) — the richer, per-device-decrypted shape
   produced by `processInboundEnvelope` / consumed by `InboundMessageRow`. Its `status` field
   (`InboundMessageStatus = 'pending' | 'decrypted' | 'unavailable'`) is what actually drives
   row rendering:

| State | `status` | Other fields set | Handled by |
|---|---|---|---|
| Decrypted | `'decrypted'` | `plaintext` | `InboundMessageRow`'s first branch — plain bubble with `message.plaintext`. |
| Pending (ciphertext/meta not yet processed) | `'pending'` | — | `InboundMessageRow`'s fallback branch — "Decrypting…" italic placeholder. |
| Unavailable / pre-link (device linked after send, no envelope) | `'unavailable'` | `unavailableReason: 'pre-link'` | `UnavailableMessagePlaceholder` via `InboundMessageRow`'s second branch. |
| Unavailable / decrypt failed | `'unavailable'` | `unavailableReason: 'undecryptable'` | Same as above, different copy. |
| Unavailable / verification failed | `'unavailable'` | `unavailableReason: 'verification-failed'` | Same as above, different copy. |
| File / image / video | n/a here — handled outside `InboundMessage`/`ChatMessage` entirely | `message.filePayload`, `message.contentType` (`'image' \| 'video' \| 'file'`) | The conversation page (`apps/web/src/app/app/conversations/[id]/page.tsx`) branches directly: image/video → `EncryptedThumbnail` + a download button; other files → a file-only download row (not shown here). |

**Not present in this codebase:** there is no "deleted tombstone" or "system event" message state —
no `tombstone`, `deleted`, or `system event` type/field was found anywhere under
`apps/web/src/components/messaging/`, `useMessageHistory.ts`, `useInboundPipeline.ts`, or
`processEnvelope.ts`. If those states are added later, they'd need a new `InboundMessageStatus` (or
a new `ChatMessage`/message-row discriminant) and a corresponding `InboundMessageRow` branch — none
currently exists to document.

The conversation page's own inline render (not using `MessageThread`/`InboundMessageRow`) is the
current production code path; it branches on, in order: a parsed `transfer` payload → `TransferCard`;
`message.unavailable` → `UnavailableMessagePlaceholder` (reason hardcoded to `'undecryptable'`, see
caveat above); `message.filePayload` with `contentType` `'image'`/`'video'` → `EncryptedThumbnail`;
`message.filePayload` with `contentType === 'file'` → a file-download-only row.
