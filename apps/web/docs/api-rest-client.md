# Backend REST Client — `lib/api.ts`

This document describes how the frontend (`apps/web`) communicates with the backend REST API: how the base URL is resolved, how every authenticated request carries credentials, how errors (including expired tokens) are handled, and which backend endpoints each part of the frontend calls.

---

## Base URL Configuration

**Source file:** [`src/lib/api.ts`](../src/lib/api.ts)

```ts
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:4000';
```

The base URL is read from the `NEXT_PUBLIC_API_URL` environment variable at build time (Next.js exposes it to the browser because of the `NEXT_PUBLIC_` prefix). A trailing slash is stripped to keep path concatenation predictable. When the variable is absent the client falls back to `http://localhost:4000`, which matches the default backend dev-server port.

### Environment variable

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:4000` | Full origin of the backend REST API, e.g. `https://api.clicked.app`. Must **not** include a trailing slash (any trailing slash is stripped automatically). |

Set this variable in your `.env.local` file (or in your deployment environment) before building or running the app:

```env
NEXT_PUBLIC_API_URL=https://api.clicked.app
```

---

## The `apiFetch` Helper

```ts
export async function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}
```

`apiFetch` is a thin wrapper around the native `fetch` API that:

1. **Prepends `API_BASE_URL`** — callers only pass the path (e.g. `'/users/me'`).
2. **Sets `Content-Type: application/json`** by default — callers can override this by including their own `Content-Type` in `init.headers`.
3. **Spreads any extra `init.headers` after the default** — so caller-supplied headers (including `Authorization`) always take precedence.

Some files import `API_BASE_URL` directly and call `fetch(…)` themselves. This is done when the caller needs precise header control (e.g. not sending `Content-Type` for a GET, or building query strings). Both patterns are in use across the codebase.

---

## Auth Header Attachment

Bearer JWT tokens are stored in `localStorage` under three keys (checked in order):

```ts
const TOKEN_STORAGE_KEYS = ['clicked.jwt', 'clicked_token', 'auth_token'];
```

The `AuthContext` (`src/contexts/AuthContext.tsx`) manages the in-memory token. Components and hooks that make authenticated requests receive the token from `useAuth()` and attach it manually:

```ts
// via apiFetch
apiFetch('/users/me', {
  headers: { Authorization: `Bearer ${token}` },
});

// via raw fetch + API_BASE_URL
fetch(`${API_BASE_URL}/conversations`, {
  headers: { Authorization: `Bearer ${token}` },
});
```

There is **no global interceptor** — every call site is responsible for passing the token it received from `useAuth()`.

### Token lifecycle

| Event | Behaviour |
|---|---|
| Sign-in | `AuthContext.signIn()` calls `POST /auth/challenge` then `POST /auth/verify`, receives a JWT, and writes it to all three `localStorage` keys. |
| Page reload | `AuthContext` reads the first non-null token from `localStorage` on mount and restores the session. |
| Sign-out | `AuthContext.signOut()` calls `removeToken()`, which deletes all three keys and clears in-memory state. |

### 401 / expired-token handling

`lib/api.ts` does **not** intercept 401 responses globally. Instead each call site checks `response.ok` and handles errors locally:

```ts
if (!response.ok) {
  throw new Error('Unable to load current user');
}
```

When a 401 is returned the typical result is:

- The operation fails with a user-facing error message.
- The token is **not** automatically removed — the user must sign out manually or re-authenticate.

There is no automatic token-refresh mechanism. Expired tokens remain in `localStorage` until the user signs out.

---

## Backend Endpoint Catalogue

All paths are relative to `API_BASE_URL`. The **Auth** column indicates whether the request attaches an `Authorization: Bearer <token>` header.

| Endpoint | Method | Auth | Description | Calling File(s) |
|---|---|---|---|---|
| `/auth/challenge` | `POST` | No | Request a sign-in challenge for a given `walletAddress`. Returns `{ message, nonce }`. | [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx) |
| `/auth/verify` | `POST` | No | Verify a signed challenge. Returns `{ token, deviceId? }`. | [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx) |
| `/users/me` | `GET` | Yes | Fetch the current user's profile (`id`, `username`, `avatarUrl`, `wallets`). | [`src/app/app/profile/page.tsx`](../src/app/app/profile/page.tsx), [`src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx) |
| `/users/me` | `PATCH` | Yes | Update the current user's `username` and `avatarUrl`. | [`src/app/app/profile/page.tsx`](../src/app/app/profile/page.tsx) |
| `/users/:userId/key-fingerprint` | `GET` | Yes | Fetch the identity key fingerprint for a given user (used for safety-number verification). | [`src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx) |
| `/users/:userId/presence` | `GET` | Yes | Fetch whether a user is currently online. Returns `{ online: boolean }`. | [`src/components/conversations/ConversationListSidebar.tsx`](../src/components/conversations/ConversationListSidebar.tsx) |
| `/conversations` | `GET` | Yes | Fetch all conversations for the current user (includes members, latest message, unread count). | [`src/components/conversations/ConversationListSidebar.tsx`](../src/components/conversations/ConversationListSidebar.tsx) |
| `/conversations/:id` | `GET` | Yes | Fetch a single conversation by ID (includes type, name, members). | [`src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx) |
| `/conversations/:id/messages` | `GET` | Yes | Fetch the message history for a conversation. Returns `{ messages: Message[] }`. | [`src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx) |
| `/devices` | `GET` | Yes | List all devices linked to the current user's account. | [`src/app/app/devices/page.tsx`](../src/app/app/devices/page.tsx) |
| `/devices/:deviceId` | `DELETE` | Yes | Revoke a device by ID. Immediately ends its session. | [`src/app/app/devices/page.tsx`](../src/app/app/devices/page.tsx) |
| `/devices/logout-everywhere` | `POST` | Yes | Revoke every device except the current one. | [`src/app/app/devices/page.tsx`](../src/app/app/devices/page.tsx) |
| `/push/subscriptions` | `POST` | Yes | Register a Web Push subscription (endpoint + keys). Idempotent — safe to call multiple times. | [`src/hooks/usePushSubscription.ts`](../src/hooks/usePushSubscription.ts) |
| `/sync` | `GET` | Yes | Pull encrypted envelopes newer than a sequence cursor. Query params: `deviceId`, `sinceSequence`. Returns `{ envelopes, nextCursor, hasMore }`. | [`src/hooks/useInboundPipeline.ts`](../src/hooks/useInboundPipeline.ts), [`src/lib/realtime.ts`](../src/lib/realtime.ts) |
| `/crypto/prekeys` | `POST` | Yes | Upload a new signed prekey and a batch of one-time prekeys after device registration. | [`src/lib/prekeyStore.ts`](../src/lib/prekeyStore.ts) |
| `/crypto/prekeys/replenish` | `POST` | Yes | Upload additional one-time prekeys when the server's supply runs low. | [`src/lib/prekeyStore.ts`](../src/lib/prekeyStore.ts) |
| `/crypto/bundles/:recipientId/:deviceId` | `GET` | Yes | Fetch the key bundle (identity key, signed prekey, one-time prekey) needed to establish an E2E session with a recipient device. | [`src/lib/sessionStore.ts`](../src/lib/sessionStore.ts) |
| `/user-devices/:senderDeviceId/public-key` | `GET` | Yes | Fetch the identity public key for a specific sender device. Results are cached in memory for the page lifetime. | [`src/lib/crypto/deviceKeys.ts`](../src/lib/crypto/deviceKeys.ts) |
| `/treasury/proposals` | `GET` | Yes | List all treasury withdrawal proposals. | [`src/app/app/treasury/page.tsx`](../src/app/app/treasury/page.tsx) |
| `/treasury/proposals/:id/approve` | `POST` | Yes | Cast an approval vote on a proposal. Body: `{ signature }`. | [`src/components/treasury/ProposalCard.tsx`](../src/components/treasury/ProposalCard.tsx) |
| `/treasury/proposals/:id/reject` | `POST` | Yes | Cast a rejection vote on a proposal. Body: `{ signature }`. | [`src/components/treasury/ProposalCard.tsx`](../src/components/treasury/ProposalCard.tsx) |
| `/treasury/propose` | `POST` | Yes | Submit a new withdrawal proposal. Body: `{ amount, token, recipient, ttl }`. | [`src/components/treasury/ProposeWithdrawalModal.tsx`](../src/components/treasury/ProposeWithdrawalModal.tsx) |

---

## Error Handling Conventions

Since there is no global interceptor, error handling is done at the call site. The patterns used across the codebase are:

1. **`response.ok` check** — All call sites check `response.ok` after `await apiFetch(…)` or `await fetch(…)`. A falsy result throws or surfaces an error message.

2. **HTTP status inspection** — Some call sites read the response status for domain-specific errors. For example, `profile/page.tsx` maps `409 Conflict` to a "username taken" message.

3. **JSON error body parsing** — On a non-OK response, callers typically parse the response body to extract a server-provided `error` or `message` field:

   ```ts
   const body = (await res.json().catch(() => ({}))) as { error?: string };
   toastError(body.error ?? 'Failed to submit proposal');
   ```

4. **Graceful degradation** — Non-critical endpoints (e.g. presence polling) swallow errors silently so a network hiccup does not break the page.
