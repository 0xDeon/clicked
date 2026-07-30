# Auth / Session Contract — `apps/web`

> Reference notes compiled by reading the source directly. Every claim below is
> tied to a file and line. No behavior is inferred beyond what the code shows.
> Token values are never reproduced here — keys are referenced by name only.

## 1. Overview

The web app authenticates through a Stellar wallet challenge/verify flow and
stores the resulting JWT in the browser's `localStorage`. The active session is
driven by `AuthProvider` in [src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx),
which connects the wallet, requests a challenge from the backend, signs it, and
persists the returned token. JWTs are decoded client-side only to read claims
(`userId`, `walletAddress`, `deviceId`) — the client never verifies the
signature or checks expiry. Device identity (an Ed25519 key generated via
WebCrypto) and end-to-end-encryption material live in `localStorage` and
IndexedDB and are established independently of the token lifecycle.

## 2. Token Storage

- **Mechanism:** `localStorage` (synchronous, origin-scoped). No cookies are
  used anywhere in `apps/web` — there is no `document.cookie` access and no
  cookie library import. `sessionStorage` is used elsewhere in the app but not
  for auth tokens.
- **Key names (active provider):** the JWT is mirrored across three keys —
  `clicked.jwt`, `clicked_token`, `auth_token` — written to all three on
  persist and removed from all three on clear.
- **Reference:** [src/contexts/AuthContext.tsx:10](../src/contexts/AuthContext.tsx#L10)
  defines `TOKEN_STORAGE_KEYS`; writes/reads/removes are at
  [src/contexts/AuthContext.tsx:28-38](../src/contexts/AuthContext.tsx#L28-L38)
  (`persistToken` writes all keys, `removeToken` deletes all keys, `readToken`
  returns the first key that has a value).

Note that two other implementations use overlapping-but-different key sets — see
[§7 Known Gaps](#7-known-gaps).

## 3. `lib/jwt.ts` API

Source: [src/lib/jwt.ts](../src/lib/jwt.ts). The client decodes the JWT payload
only — it never verifies the signature and never checks `exp`/expiry.

| Export | Purpose | Input | Output |
| --- | --- | --- | --- |
| `JwtPayload` (interface) | Shape of the decoded payload the client relies on | — | `{ userId: string; walletAddress: string; deviceId: string }` |
| `parseJwtPayload` | Decode the base64url payload segment and JSON-parse it; returns `null` if the token has no payload, if decoding throws, or if `userId`/`deviceId` are absent. No signature or expiry check. | `token: string` | `JwtPayload \| null` |
| `getE2EDeviceId` | Return the E2E device id — prefers the value stored under the `clicked.e2eDeviceId` localStorage key, otherwise falls back to `deviceId` from the decoded token. Documented as `userDevices.id` for envelope sync, which "may differ from JWT devices.id". | `token: string` | `string \| null` |
| `setE2EDeviceId` | Persist the E2E device id under the `clicked.e2eDeviceId` localStorage key (no-op when `window` is undefined, e.g. SSR). | `deviceId: string` | `void` |

## 4. Session Initialization Sequence

Driven by `AuthProvider` in
[src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx).

**Token present (returning session):** on mount, a `useEffect`
([src/contexts/AuthContext.tsx:53-59](../src/contexts/AuthContext.tsx#L53-L59))
runs:
1. `readToken()` returns the first non-empty value among the three storage keys.
2. If found, `setToken(savedToken)`.
3. `setUser(parseJwtUser(savedToken))` — `parseJwtUser` calls `parseJwtClaims`
   (from `@/lib/realtime`) and builds the user only if `walletAddress` is
   present in the claims.

No signature check, no expiry check, and no server round-trip occur on
initialization. A stale or expired token is trusted and used as-is until a
backend request rejects it.

**Token absent / expired:** if `readToken()` returns `null`, `token` and `user`
stay `null` and the app is unauthenticated. There is no automatic recovery. A
session is established only when `signIn()`
([src/contexts/AuthContext.tsx:61-101](../src/contexts/AuthContext.tsx#L61-L101))
is invoked:
1. Resolve `walletAddress` from the wallet context (`publicKey ?? await connect()`).
2. `getOrCreateDeviceIdentity()` — loads or generates the Ed25519 device identity.
3. `POST /auth/challenge` with `{ walletAddress }` → `{ message, nonce }`.
4. `signWalletMessage(message, walletAddress)` via Freighter.
5. `POST /auth/verify` with `{ walletAddress, signature, nonce, identityPublicKey }`.
6. On success: if the response includes `deviceId`, `rememberRealtimeDeviceId(deviceId)`;
   then `persistToken(nextToken)`, `setToken`, and `setUser`.

## 5. Refresh Behavior

There is **no token refresh mechanism**. Nothing in the read files re-issues,
rotates, or silently renews the JWT. There is no refresh token, no expiry timer,
no interval, and no retry-on-401 logic in the auth provider. A token persists in
`localStorage` until `signOut()` is called or the user manually re-runs
`signIn()`. Because the client never inspects expiry, an expired token remains
in storage and continues to be sent until the backend rejects it — and even then
nothing clears or refreshes it automatically.

## 6. Logout / Clear Behavior

`signOut()`
([src/contexts/AuthContext.tsx:103-107](../src/contexts/AuthContext.tsx#L103-L107))
clears exactly:
- The three token keys via `removeToken()` — `clicked.jwt`, `clicked_token`,
  `auth_token`.
- React state: `setToken(null)` and `setUser(null)`.

**Device-side crypto state is NOT cleared.** `signOut` does not touch any of the
following, all of which survive logout:
- The Ed25519 device identity in `localStorage`:
  `clicked.e2eeDeviceId` and `clicked.deviceIdentityPublicKey`
  ([src/lib/deviceIdentity.ts:3-4](../src/lib/deviceIdentity.ts#L3-L4)),
  generated via `crypto.subtle.generateKey({ name: 'Ed25519' }, …)`.
- The realtime device id key `clicked.e2eeDeviceId` and the socket resume/sync
  cursors (`clicked.socket.resumeCursor:*`, `clicked.socket.syncSequence:*`)
  in `localStorage` ([src/lib/realtime.ts:34-36](../src/lib/realtime.ts#L34-L36)).
- The `clicked.e2eDeviceId` key owned by `lib/jwt.ts`.
- Any IndexedDB stores holding E2EE material (the app uses both the native
  `indexedDB` API and the `idb` `openDB` wrapper).

So logout is a token-and-React-state clear only; all WebCrypto and IndexedDB
key material persists on the device across sign-out.

## 7. Known Gaps

Surprising things observed directly in the code:

1. **Three overlapping auth implementations.** Besides the active provider in
   `src/contexts/AuthContext.tsx`, there is a second provider
   `src/components/auth/AuthProvider.tsx` (uses the thin context shell
   `src/components/auth/AuthContext.tsx`, key order
   `['clicked_token', 'clicked.jwt', 'auth_token']` — different from the active
   provider's `['clicked.jwt', 'clicked_token', 'auth_token']`), and a third in
   `src/lib/auth.tsx` (its own context/provider using only `auth_token`, with an
   additional fallback to `process.env.NEXT_PUBLIC_AUTH_TOKEN`). These do not
   share state and can diverge on the same origin.
2. **No client-side signature or expiry verification.** All decode paths
   (`parseJwtPayload`, `parseJwtClaims`) only base64url-decode and JSON-parse the
   payload. An expired or tampered token is trusted client-side until the backend
   rejects a request.
3. **`e2eDeviceId` vs `e2eeDeviceId` key mismatch.** `lib/jwt.ts` reads/writes
   `clicked.e2eDeviceId` (single `e2e`), while `deviceIdentity.ts` and
   `realtime.ts` use `clicked.e2eeDeviceId` (double `e2e`). These are distinct
   localStorage keys, so the JWT helper and the device/realtime layers do not
   share a device id through storage.
4. **Logout leaves crypto/IndexedDB state.** As noted in §6, device identity,
   realtime cursors, and IndexedDB E2EE material survive `signOut`, so a
   subsequent user on the same browser inherits the prior device's crypto state.
5. **Env-var token fallback.** `src/lib/auth.tsx` seeds its token from
   `process.env.NEXT_PUBLIC_AUTH_TOKEN` when no stored token exists, which bakes
   a token source into the client bundle build.
