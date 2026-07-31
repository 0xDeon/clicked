# JWT & auth token lifecycle contract

This document describes the JWT contract implemented today: what each claim
means, how tokens are signed and expire, and how the HTTP and WebSocket
middleware re-validate a token against live device state on every request or
connection — not just against the token's signature.

Implementation references:

- token signing/verification: `apps/backend/src/lib/jwt.ts`
- HTTP auth middleware: `apps/backend/src/middleware/auth.ts`
- WebSocket auth middleware: `apps/backend/src/middleware/socketAuth.ts`
- mid-session revocation broadcast: `apps/backend/src/services/deviceRevocation.ts`
- token issuance: `apps/backend/src/routes/auth.ts` (`POST /auth/verify`)
- device schema: `apps/backend/src/db/schema.ts` (`devices`)

## Claims

The full and only shape of the token payload is `JwtPayload`
(`apps/backend/src/lib/jwt.ts`):

| Claim | Type | Meaning |
| --- | --- | --- |
| `userId` | `string` (uuid) | The backend `users.id` row this token authenticates. |
| `walletAddress` | `string` | The Stellar wallet address (`G...`) that completed the challenge/verify sign-in. Carried for convenience; not re-checked against the DB on every request. |
| `deviceId` | `string` (uuid) | The backend `devices.id` row for the device that signed in. This is the field live re-validation keys off of — see below. |

There are no other claims beyond what `jsonwebtoken` itself adds (`iat`,
`exp`). There is no `roles`/`scope` claim — authorization beyond
"authenticated as this user on this device" is enforced per-route, not in the
token.

Tokens issued before device-aware auth existed (i.e. missing `deviceId`) are
treated as legacy and are always rejected — see "Rejection reasons" below.

## Signing

- Algorithm: whatever `jsonwebtoken`'s `jwt.sign`/`jwt.verify` default to when
  no `algorithm` option is passed — HS256 (HMAC-SHA256), a single shared
  secret used both to sign and to verify.
- Secret source: the `JWT_SECRET` environment variable.
  - `apps/backend/src/config.ts` validates `JWT_SECRET` as a required,
    non-empty string at startup (`EnvSchema`) — the process fails to boot
    without it in a real environment.
  - `apps/backend/src/lib/jwt.ts` itself falls back to the literal
    `'test-secret'` if `process.env['JWT_SECRET']` is unset, and writes that
    fallback back into `process.env['JWT_SECRET']` so it's consistent for the
    rest of the process. This fallback exists only to keep tests
    self-contained; it is not reachable in a real deployment because
    `config.ts` already refused to start.
- Tokens are only ever minted in one place: `signToken()`, called from
  `POST /auth/verify` after wallet-signature verification and device
  resolution succeed (`apps/backend/src/routes/auth.ts`).

## Token lifetime

- Expiry is fixed at **7 days** (`expiresIn: '7d'` in `signToken()`). This is
  the only expiry value in the codebase — there is no per-token or
  per-environment override.
- `verifyToken()` uses `jsonwebtoken`'s built-in expiry check
  (`jwt.verify` throws `TokenExpiredError` once `exp` has passed); both
  `requireAuth` and `socketAuthMiddleware` catch that and return a generic
  "Invalid or expired token" / "Invalid or expired token" error rather than
  distinguishing expiry from a bad signature, so clients cannot use the error
  message to tell the two apart.
- **There is no refresh token and no refresh endpoint.** `POST /auth/verify`
  is the only way to obtain a token, and it always goes through the full
  wallet-challenge/signature flow again. When a token expires, the client
  must redo `POST /auth/challenge` + `POST /auth/verify` from scratch to get
  a new one — there is no silent renewal.

## Live re-validation against device state

A syntactically and cryptographically valid token (correct signature,
unexpired, well-formed claims) is **not sufficient** to be treated as
authenticated. Both HTTP and WebSocket auth paths perform an additional
database check on every single request/connection: the `(userId, deviceId)`
pair from the token must resolve to a `devices` row, and that row's
`revokedAt` must be `null`.

This means revoking a device (`DELETE /devices/:id` or
`POST /devices/logout-everywhere`, see `apps/backend/src/routes/devices.ts`)
takes effect immediately for every future request bearing a token issued to
that device — even though the token itself is still validly signed and not
yet expired. The token's signature only proves "this payload was issued by
the server"; it says nothing about whether the device is still allowed to
act. Device state, not signature validity, is the actual authorization
source of truth.

### HTTP: `requireAuth` (`apps/backend/src/middleware/auth.ts`)

Runs on every authenticated HTTP request:

1. Require an `Authorization: Bearer <token>` header; 401 if missing/malformed.
2. `verifyToken(token)` — 401 ("Invalid or expired token") on bad signature,
   expiry, or a legacy token missing `deviceId`.
3. Look up `devices` where `id = payload.deviceId AND userId = payload.userId`.
4. 401 ("Device not found or has been revoked") if no such device exists, or
   if it exists but `revokedAt` is non-null.
5. Only after all of the above does the request proceed, with
   `req.auth` set to the decoded payload.

This DB check happens on **every** request, not just at login — so a device
revoked mid-lifetime of an otherwise-unexpired token is rejected on its very
next HTTP call.

### WebSocket: `socketAuthMiddleware` (`apps/backend/src/middleware/socketAuth.ts`)

Runs once, during the Socket.IO connection handshake (`socket.handshake.auth['token']`):

1. Reject the connection if no token was supplied.
2. `verifyToken(token)` — reject the connection on bad signature, expiry, or
   missing `deviceId`.
3. Same `devices` lookup as HTTP: reject the connection if the device is
   missing or `revokedAt` is set.
4. On success, `socket.auth` is set to the decoded payload and
   `socket.identityPublicKey` is set from the device row.

Because this check only runs at handshake time, a device revoked **after** a
socket has already connected would not be caught by this middleware alone —
the connection is already established. That gap is closed separately by
`apps/backend/src/services/deviceRevocation.ts`: revoking a device
(`revokeDeviceRow`) publishes `device_revoked:<deviceId>` over Redis pub/sub,
and every backend node listening on that channel looks up any live socket(s)
registered for that device and forcibly disconnects them
(`socket.emit('device_revoked', ...)` then `socket.disconnect(true)`), across
all nodes, not just the one that handled the original request. So a revoked
device cannot make a new WebSocket connection (blocked by
`socketAuthMiddleware`) and cannot keep using an existing one (force-closed by
the revocation broadcast) — the two mechanisms together give the same
immediate-effect guarantee that HTTP's per-request re-validation gives.

## Rejection reasons summary

| Condition | HTTP (`requireAuth`) | WebSocket (`socketAuthMiddleware`) |
| --- | --- | --- |
| Missing token | 401 "Missing or invalid Authorization header" | connection error: "Authentication token required" |
| Bad signature / malformed | 401 "Invalid or expired token" | connection error: "Invalid or expired token" |
| Expired (`exp` passed) | 401 "Invalid or expired token" | connection error: "Invalid or expired token" |
| Legacy token missing `deviceId` | 401 "Invalid or expired token" (thrown by `verifyToken`, caught generically) | connection error: "Invalid or expired token" |
| Device row not found | 401 "Device not found or has been revoked" | connection error: "Device not found or has been revoked" |
| Device revoked (`revokedAt` set) | 401 "Device not found or has been revoked" | connection error: "Device not found or has been revoked" |
| Device revoked **after** an existing socket connected | n/a (HTTP has no persistent connection) | live socket force-disconnected via `device_revoked` broadcast, not via this middleware |
