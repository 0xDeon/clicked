# Frontend error handling and user feedback

How failures reach the user in `apps/web`: REST API errors, WebSocket/socket errors,
wallet rejections, and decryption failures. Covers the toast system
(`lib/useToast.ts`), when a route uses inline error state instead, the socket `error`
event, and what happens to a message when sending it ultimately fails.

There is **no global error interceptor** in this app — no fetch middleware, no error
boundary that turns every failure into the same UI. Each call site decides how to surface
its own failure. This document describes the two patterns in use, when to reach for each,
and the one case (decryption) where the presentation is a hard rule rather than a
per-call-site choice.

---

## The toast API (`lib/useToast.ts`)

```ts
const { notify, success, error, info, dismiss } = useToast();

success('Withdrawal proposal submitted successfully');
error(body.error ?? 'Failed to submit proposal');
info('Reconnecting…');
```

`useToast()` reads a `ToastContext` provided by `<ToastProvider>` (mounted once in
`app/layout.tsx`, above the whole app). Calling it outside the provider throws
immediately — this is intentional, so a missing provider fails loudly in development
rather than showing nothing in production.

Toasts:

- Render bottom-right, stack, and auto-dismiss after 4 seconds (`ToastProvider.tsx`), or
  can be dismissed early by the user or by calling `dismiss(id)`.
- Have three variants — `success`, `error`, `info` — each with its own colour and icon.
- Are **transient and global**. They are the right choice for the result of a discrete
  action the user just took (submit a proposal, save a setting, a network error on submit)
  where the relevant context (a modal, a form) may already be gone by the time the result
  is known.

### When to use a toast vs. inline error state

| Use a toast when… | Use inline error state when… |
| --- | --- |
| The action is a one-off submission (form, modal, button click) and success/failure is transient feedback. | The error is about a specific field or a specific piece of persistent UI (a route, a panel) that stays on screen. |
| The user can immediately retry the same action from where they are. | The user needs to see *why*, next to *what*, for more than 4 seconds — e.g. a validation message under an input. |
| Example: `ProposeWithdrawalModal` toasts `'Network error — please try again'` on a failed `POST /treasury/propose`, while validation errors (bad recipient address) are set as component state and rendered under the field, not toasted. | Example: a route that fails to load its primary data (a conversation, a proposal list) renders an inline empty/error state in place of the content, since a toast would disappear while the broken screen remains. |

Both can apply to the same failure at different layers: a form's *field-level* validation
error is inline, while the same form's *submit* failure (a rejected `fetch`) is a toast.
See `components/treasury/ProposeWithdrawalModal.tsx` for both patterns side by side in one
component.

Toast adoption is not yet universal — some call sites currently only `console.error` a
failure with no user-visible feedback at all (see [Socket errors](#socket-errors) and
[Send failures](#send-failures-and-what-happens-to-the-message) below). Treat "toast or
inline state, chosen deliberately" as the standard for new code, not the current state of
every existing call site.

---

## Mapping backend errors to user-facing messages

There is no global response interceptor, so every call site is responsible for checking
`response.ok` and reading the backend's error body itself:

```ts
const res = await apiFetch('/treasury/propose', { method: 'POST', body: /* ... */ });

if (!res.ok) {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  toastError(body.error ?? 'Failed to submit proposal');
  return;
}
```

The backend's validation failures follow one consistent shape —
`{ error: string, issues?: [{ field, message }] }` at `400 Bad Request` — documented in
[REST schemas — Error Response Format](../../backend/docs/contracts-rest-schemas.md#error-response-format).
When a route surfaces a validation failure to the user, prefer showing `issues[].message`
next to the relevant field (inline) over the top-level `error` string in a toast, since the
top-level string is often generic (`"Validation failed"`) while `issues` names the actual
problem.

For endpoint-specific error conditions (expired sessions, ownership checks, rate limits),
consult the relevant backend API doc — e.g.
[Auth API](../../backend/docs/api-auth.md),
[Devices and prekeys API](../../backend/docs/api-devices.md) — for the exact status codes
and error strings a given route can return, so the frontend message matches what actually
happened rather than a generic fallback.

### 401 / expired session

`lib/api.ts` does not intercept 401s globally (see
[REST client — 401 / expired-token handling](api-rest-client.md)). A 401 on any given call
surfaces through that call's own `!res.ok` branch like any other error; there is currently
no app-wide "your session expired, please sign in again" redirect triggered centrally —
each screen's own error handling is what the user sees.

### Wallet rejections

Wallet interactions (`connect()`, transaction signing) reject their promise when the user
declines in the wallet UI. The current pattern:

```ts
try {
  await connect();
} catch (err) {
  console.error('Wallet connection failed:', err);
} finally {
  setIsConnecting(false);
}
```

A rejected wallet connection currently resets loading state but does not show the user a
toast or inline message distinguishing "you declined" from "the wallet extension isn't
installed" from "the connection timed out" — all three collapse to a silent no-op from the
user's point of view. This is a gap worth closing with a toast (`toastError('Connection
request was declined')` or similar) rather than a pattern to copy into new wallet-driven
flows.

---

## Socket errors

`lib/socket.ts` registers a generic handler on the shared socket:

```ts
socket.on('error', (error) => console.error('Socket error:', error));
```

This is diagnostic only — a socket-level error (auth rejected on connect, a malformed
server event) is logged to the console and otherwise invisible to the user. Reconnection
itself is handled separately by `socket.io-client`'s built-in `reconnection: true` option,
so transient network drops recover without user action; what is *not* currently surfaced is
a persistent failure (e.g. repeated reconnection failures) as a toast or a "reconnecting…"
indicator. If you are building UI that depends on socket delivery (typing indicators,
presence, live message arrival), do not assume the user will see any signal if the socket
is silently failing — treat this as a known gap rather than an existing pattern to rely on.

---

## Decryption failures — never a generic crash

**Rule:** a message that fails to decrypt, fails verification, or arrives before the local
session exists must never be rendered as a thrown error, a broken row, or a generic "something
went wrong" state. It always renders as `UnavailableMessagePlaceholder`, a calm, specific,
in-flow placeholder — never a toast, never an error boundary.

```ts
export type UnavailableReason = 'pre-link' | 'undecryptable' | 'verification-failed';
```

```tsx
// components/messaging/UnavailableMessagePlaceholder.tsx
const REASON_COPY: Record<UnavailableReason, string> = {
  'pre-link': 'Waiting for secure session — message from before this device was linked.',
  undecryptable: 'Unable to decrypt this message.',
  'verification-failed': 'Message could not be verified.',
};

<div role="note" aria-label="Encrypted message unavailable">
  🔒 {REASON_COPY[reason]}
</div>
```

Why this is a hard rule rather than a style preference:

- **It is expected, not exceptional.** `pre-link` in particular happens routinely — any
  message sent before the current device completed session setup is legitimately
  undecryptable on this device by design, not a bug. Presenting it as an alarming failure
  would train users to distrust normal E2EE behaviour.
- **It is isolated.** Crashing that row (or the whole thread) on one bad message would
  take down an otherwise healthy conversation.
- **It is inline, in the message's position in the thread** (`InboundMessageRow` renders
  it in place of the decrypted bubble), so the conversation's shape and ordering are
  preserved — the user sees *that* a message exists and roughly when, just not its content.

When adding a new code path that can fail to decrypt or verify a message, route it through
`UnavailableReason` / `UnavailableMessagePlaceholder` rather than letting the failure
propagate as a thrown exception into the render tree.

---

## Retry and offline behaviour

### Send failures and what happens to the message

Sending an encrypted text message (`handleSendEncrypted` in
`app/app/conversations/[id]/page.tsx`) is not currently optimistic in the UI-state sense —
the composer's text is only cleared (`setSendText('')`) **after** the encrypt-and-send
call succeeds:

```ts
async function handleSendEncrypted() {
  if (!sendText.trim() || !socket || !token) return;
  setSending(true);
  try {
    await sendEncryptedMessage({ /* ... */ });
    socket.emit('send_message', { /* ... */ });
    setSendText('');
  } catch (err) {
    console.error('Failed to send encrypted message:', err);
  } finally {
    setSending(false);
  }
}
```

Practically, this means:

- **On failure**, the typed text is preserved in the composer (never cleared), so nothing
  the user wrote is lost — but there is currently no toast or inline indicator telling the
  user the send failed at all; the only signal today is a console error and the message
  simply not appearing in the thread. The user's next reasonable action is pressing send
  again, which works because the text is still there, but nothing prompts them to.
- **There is no automatic retry.** A failed send is not queued or retried by the app; it is
  a dead end until the user notices and resends manually.
- **There is no offline queue.** The service worker does not intercept `fetch` or queue
  failed sends (see
  [Service worker — offline behaviour today](concepts-service-worker.md#offline-behaviour-today)).
  A message typed while offline fails the same way any other network error does, with the
  same silent-console-only signal — it is not saved for automatic delivery once
  connectivity returns.

If you are extending the composer, wiring `toastError('Message failed to send')` into that
`catch` block is a small, low-risk improvement consistent with the rest of this document's
[toast guidance](#the-toast-api-libusetoastts) — the current silent failure is a gap, not a
pattern to preserve.
