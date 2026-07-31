# Auth & session API

This document describes every route exposed by `apps/backend/src/routes/auth.ts`:

- `POST /auth/challenge` — nonce issuance
- `POST /auth/verify` — wallet signature verification, device registration, JWT issuance

There are **no refresh or logout routes** in `auth.ts`. Session expiry is handled entirely by the JWT lifetime (7 days). A device-level logout-everywhere endpoint exists at `POST /devices/logout-everywhere` (see [`devices.ts`](../src/routes/devices.ts)) and device revocation is checked during `POST /auth/verify`.

## Rate limiting

Two named rate-limiters are applied to individual routes. Both use express-rate-limit with `standardHeaders: 'draft-7'` and `legacyHeaders: false`.

| Limiter | Window | Max requests | Applied to |
|---|---|---|---|
| `challengeLimiter` | 60 s | 10 | `POST /auth/challenge` |
| `verifyLimiter` | 60 s | 5 | `POST /auth/verify` |

When a limiter is breached the server responds with HTTP `429`:

```json
{ "error": "Too many requests" }
```

---

## `POST /auth/challenge`

Issues a single-use nonce that the client must sign with their Stellar wallet to prove ownership of the wallet address.

**Auth:** None (unauthenticated).

### Request body

Validated against `ChallengeSchema` (`apps/backend/src/schemas/auth.schemas.ts`).

```json
{
  "walletAddress": "G..."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `walletAddress` | `string` | yes | Stellar public key (starting with `G`) |

### Responses

#### `200` — Nonce issued

```json
{
  "message": "Sign in to Clicked\nWallet: G...\nNonce: abc123def456",
  "nonce": "abc123def456"
}
```

| Field | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable message the wallet must sign. Format: `Sign in to Clicked\nWallet: {walletAddress}\nNonce: {nonce}` |
| `nonce` | `string` | Hex-encoded 16-byte random nonce. Single-use, expires after 5 minutes. |

#### `400` — Validation error

Returned when `walletAddress` is missing or empty.

```json
{
  "error": "walletAddress is required"
}
```

#### `429` — Rate limited

```json
{ "error": "Too many requests" }
```

### Nonce lifecycle

- Created by `createNonce()` in `apps/backend/src/lib/nonce.ts`
- Stored in-memory (Map) keyed by `walletAddress`
- TTL of 5 minutes from creation
- Consumed (deleted) by `POST /auth/verify` — single-use
- If the same wallet requests a new challenge, the previous nonce is silently overwritten

---

## `POST /auth/verify`

Verifies a signed challenge message, resolves or creates the user and device, and returns a JWT.

**Auth:** None (unauthenticated), but requires a nonce obtained from `POST /auth/challenge` first.

### Request body

Validated against `VerifySchema` (`apps/backend/src/schemas/auth.schemas.ts`).

```json
{
  "walletAddress": "G...",
  "signature": "hex-or-base64-encoded-signature",
  "nonce": "abc123def456",
  "identityPublicKey": "base64-ed25519-spki-der",
  "device": {
    "deviceName": "My Laptop",
    "platform": "web",
    "registrationId": 42
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `walletAddress` | `string` | yes | Stellar public key (starting with `G`) |
| `signature` | `string` | yes | Wallet signature of the challenge message. Accepts both hex and base64 encodings (the server tries both). |
| `nonce` | `string` | yes | The nonce returned by `POST /auth/challenge`. Single-use. |
| `identityPublicKey` | `string` | yes | Base64-encoded Ed25519 SPKI DER public key (44 bytes decoded). The long-term device identity key. |
| `device` | `object` | no | Optional device metadata. |
| `device.deviceName` | `string` | no | Human-readable device name (max 100 chars). |
| `device.platform` | `string` | no | One of `"web"`, `"ios"`, or `"android"`. |
| `device.registrationId` | `number` | no | Non-negative integer for push notification routing. |
| `device.identityPublicKey` | `string` | no | If provided, must match the top-level `identityPublicKey`. Validated via `superRefine`. |

### Responses

#### `200` — Authenticated

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "deviceId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field | Type | Description |
|---|---|---|
| `token` | `string` | Signed JWT (7-day expiry). Payload: `{ userId, walletAddress, deviceId }`. |
| `deviceId` | `string` | UUID of the resolved or newly-registered device row. |

#### `400` — Validation error

Returned when any required field is missing or fails schema validation (e.g., invalid base64, wrong byte length for `identityPublicKey`, or `device.identityPublicKey` mismatch).

```json
{ "error": "identityPublicKey must be 44 bytes (got 12)" }
```

#### `401` — Invalid or expired nonce

```json
{ "error": "Invalid or expired nonce" }
```

#### `401` — Signature verification failed

Returned when the wallet signature does not match the expected message signed by `walletAddress`.

```json
{ "error": "Signature verification failed" }
```

#### `401` — Invalid signature or wallet address

Returned when the `walletAddress` is not a valid Stellar public key or the `signature` cannot be decoded.

```json
{ "error": "Invalid signature or wallet address" }
```

#### `401` — Device revoked

Returned when a device with the given `(userId, identityPublicKey)` exists but has been revoked (`revokedAt` is set).

```json
{ "error": "Device has been revoked" }
```

#### `500` — Failed to create user

```json
{ "error": "Failed to create user" }
```

#### `500` — Failed to register device

```json
{ "error": "Failed to register device" }
```

#### `429` — Rate limited

```json
{ "error": "Too many requests" }
```

### Verification flow (server-side order)

1. **Nonce consumed** — `consumeNonce()` validates and deletes the nonce. Rejects if missing, expired, or mismatched.
2. **Signature verified** — The server reconstructs the challenge message and tries two signature verification strategies:
   - **Raw message**: `SHA-256("Stellar Signed Message:\n" + message)` → base64 decode → `Keypair.verify()` (Freighter-compatible path)
   - **Raw bytes**: `Buffer.from(message)` → hex decode → `Keypair.verify()`
   - Either succeeding is sufficient.
3. **User/wallet upserted** — Looks up existing wallet by address. If found, uses its `userId`. If not, creates a new user row and a new wallet row.
4. **Device resolved** — Looks up existing device by `(userId, identityPublicKey)`:
   - If found and `revokedAt` is set → reject.
   - If found and not revoked → update `lastSeenAt` and optional metadata.
   - If not found → insert new device row.
5. **JWT issued** — Signed with `userId`, `walletAddress`, and `deviceId`. Expires in 7 days.

---

## Worked example: full challenge → sign → verify flow

### Step 1: Request challenge

```
POST /auth/challenge
Content-Type: application/json

{
  "walletAddress": "GA7QVN3R5X24Q3K6V3X6K5Y5Q6Q7QVN3R5X24Q3K6V3X6K5Y5Q6Q7Q"
}
```

Response:

```
200 OK

{
  "message": "Sign in to Clicked\nWallet: GA7QVN3R5X24Q3K6V3X6K5Y5Q6Q7QVN3R5X24Q3K6V3X6K5Y5Q6Q7Q\nNonce: a1b2c3d4e5f6a7b8c9d0e1f2",
  "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2"
}
```

### Step 2: Sign the message with the wallet

The client signs the `message` string using the Stellar wallet's private key (e.g., via Freighter or a direct `Keypair.sign()`).

The raw signing input is:

```
Sign in to Clicked
Wallet: GA7QVN3R5X24Q3K6V3X6K5Y5Q6Q7QVN3R5X24Q3K6V3X6K5Y5Q6Q7Q
Nonce: a1b2c3d4e5f6a7b8c9d0e1f2
```

The resulting signature is a 64-byte Ed25519 value that can be encoded as hex or base64.

### Step 3: Verify the signature

```
POST /auth/verify
Content-Type: application/json

{
  "walletAddress": "GA7QVN3R5X24Q3K6V3X6K5Y5Q6Q7QVN3R5X24Q3K6V3X6K5Y5Q6Q7Q",
  "signature": "4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4",
  "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "identityPublicKey": "MCowBQYDK2VwAyEA3kBmP7QsHyP4nY7sKQgJ3Kp5X6w8z9a0b1c2d3e4f5g6h7",
  "device": {
    "deviceName": "My Laptop",
    "platform": "web",
    "registrationId": 12345
  }
}
```

Response:

```
200 OK

{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAiLCJ3YWxsZXRBZGRyZXNzIjoiR0E3UVZOM1I1WDI0UTNLNlYzWDZLNVk1UTZRN1FWTjNSNVgyNFFLM0s2VjNYNks1WTVRNlE3USIsImRldmljZUlkIjoiNjYwZTg0MDAtZTI5Yi00MWQ0LWE3MTYtNDQ2NjU1NDQwMDAwIiwiaWF0IjoxNzE5MDAwMDAwLCJleHAiOjE3MTk2MDUwMDB9.signature",
  "deviceId": "660e8400-e29b-41d4-a716-446655440000"
}
```

The client decodes the JWT to extract `userId` and uses `deviceId` for subsequent authenticated requests (e.g., prekey upload at `POST /devices/:deviceId/prekeys`).

---

## Implementation references

- Route handler: `apps/backend/src/routes/auth.ts`
- Request schemas: `apps/backend/src/schemas/auth.schemas.ts`
- Nonce creation/consumption: `apps/backend/src/lib/nonce.ts`
- JWT signing/verification: `apps/backend/src/lib/jwt.ts`
- Key validation helpers: `apps/backend/src/lib/keys.ts`
- Database schema (users, wallets, devices): `apps/backend/src/db/schema.ts`
