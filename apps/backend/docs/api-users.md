# Users API

**Router file:** `apps/backend/src/routes/users.ts`  
**Mount path:** `/users`  
**Auth:** Every route in this router requires a valid Bearer JWT (`requireAuth` applied router-wide). The JWT is issued by `POST /auth/verify` and encodes `{ userId, walletAddress, deviceId }`. Requests with a missing, malformed, or expired token, or whose `deviceId` is revoked, are rejected before any route handler runs.

---

## Table of contents

1. [Authentication](#authentication)
2. [GET /users/search](#get-userssearch)
3. [GET /users/me](#get-usersme)
4. [PATCH /users/me](#patch-usersme)
5. [GET /users/:id](#get-usersid)
6. [GET /users/:id/presence](#get-usersidpresence)
7. [GET /users/:id/key-fingerprint](#get-usersidkey-fingerprint)
8. [GET /users/:userId/devices/:deviceId/key-bundle](#get-usersuseriddevicesdeviceidkey-bundle)
9. [Common status codes](#common-status-codes)
10. [Data model reference](#data-model-reference)

---

## Authentication

All routes share the same auth gate enforced by the `requireAuth` middleware.

### How authentication works

```
Authorization: Bearer <jwt>
```

The middleware:

1. Reads the `Authorization` header and verifies it starts with `Bearer `.
2. Verifies the JWT signature using the server secret.
3. Extracts the `deviceId` claim from the payload.
4. Looks up `(deviceId, userId)` in the `devices` table and confirms the device exists and `revokedAt IS NULL`.
5. Attaches the decoded payload as `req.auth` and calls `next()`.

### Auth error responses

| Condition | Status | Body |
|---|---|---|
| Missing or non-Bearer header | `401` | `{ "error": "Missing or invalid Authorization header" }` |
| Invalid or expired JWT | `401` | `{ "error": "Invalid or expired token" }` |
| JWT missing `deviceId` claim | `401` | `{ "error": "Token missing deviceId" }` |
| Device not found or revoked | `401` | `{ "error": "Device not found or has been revoked" }` |

---

## GET /users/search

Search for users by username prefix or by exact wallet address.

### Request

```
GET /users/search?q=<query>
Authorization: Bearer <jwt>
```

| Parameter | In | Type | Required | Description |
|---|---|---|---|---|
| `q` | query | string | Yes | Username prefix (case-insensitive) **or** exact Stellar wallet address |

**Matching behaviour:**
- Username matching is a case-insensitive prefix search (`ILIKE '<q>%'`).
- Special LIKE wildcard characters in `q` (`\`, `%`, `_`) are automatically escaped so user input is always treated literally.
- Wallet address matching is an exact equality check against the `wallets.address` column — no prefix expansion.
- Both conditions are evaluated with `OR`: a user matching either criterion is included.
- Results are capped at **10 users**.

### Success response — `200 OK`

```json
[
  {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "username": "alice",
    "avatarUrl": "https://example.com/alice.png",
    "primaryWalletAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE"
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID) | User ID |
| `username` | `string \| null` | Display name |
| `avatarUrl` | `string \| null` | Avatar image URL |
| `primaryWalletAddress` | `string \| null` | The wallet where `isPrimary = true`; `null` if no primary wallet is set |

The response is a flat array. Wallet details beyond the primary address are not exposed — the per-user `wallets` array is not included.

### Error responses

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Query parameter \"q\" is required" }` | `q` is absent or after trimming is an empty string |
| `500` | `{ "error": "Search failed" }` | Unexpected database error |

---

## GET /users/me

Fetch the authenticated user's own profile. Returns fields that are private to the caller (e.g. `presenceVisible`, full wallet list, `createdAt`).

### Request

```
GET /users/me
Authorization: Bearer <jwt>
```

No path parameters or query parameters.

### Success response — `200 OK`

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "username": "alice",
  "avatarUrl": "https://example.com/alice.png",
  "presenceVisible": true,
  "wallets": [
    { "address": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE", "isPrimary": true },
    { "address": "GHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJK", "isPrimary": false }
  ],
  "createdAt": "2026-01-15T10:30:00.000Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID) | Stable user identifier |
| `username` | `string \| null` | `null` until the user sets one |
| `avatarUrl` | `string \| null` | |
| `presenceVisible` | `boolean` | When `false`, the user's online status is hidden from other users |
| `wallets` | `Array<{ address: string, isPrimary: boolean }>` | All linked wallets |
| `createdAt` | `string` (ISO 8601) | Account creation timestamp |

### Error responses

| Status | Body | Condition |
|---|---|---|
| `404` | `{ "error": "User not found" }` | The user record for `req.auth.userId` no longer exists |

---

## PATCH /users/me

Update the authenticated user's profile. All body fields are optional; omitted fields are left unchanged. At least one mutable field should be provided for the request to have any effect (sending an empty body is accepted but is a no-op aside from bumping `updatedAt`).

### Request

```
PATCH /users/me
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{
  "username": "alice_updated",
  "avatarUrl": "https://example.com/new-avatar.png",
  "presenceVisible": false
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `username` | `string` | No | 3–30 characters; only `[a-zA-Z0-9_]` allowed |
| `avatarUrl` | `string \| null` | No | No server-side format validation |
| `presenceVisible` | `boolean` | No | Must be a strict boolean, not a string |

### Success response — `200 OK`

Returns the full updated user row as stored in the database (the raw Drizzle `.returning()` result — all columns of the `users` table):

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "username": "alice_updated",
  "avatarUrl": "https://example.com/new-avatar.png",
  "presenceVisible": false,
  "sendReadReceipts": true,
  "createdAt": "2026-01-15T10:30:00.000Z",
  "updatedAt": "2026-05-31T14:00:00.000Z"
}
```

> **Note:** Unlike `GET /users/me`, which selects an explicit column subset, `PATCH /users/me` uses `.returning()` with no column filter. This means all `users` table columns are returned, including `sendReadReceipts`. Clients should treat any unrecognised fields as additive and non-breaking.

### Presence visibility side-effect

When `presenceVisible` changes value (old ≠ new), the server emits real-time Socket.IO events to all conversation rooms the user belongs to:

- `presenceVisible` toggled **to `true`** while the user is currently online:
  - Emits `user_online` and `presence_update { userId, online: true }` to every conversation room.
- `presenceVisible` toggled **to `false`** while the user is currently online:
  - Emits `user_offline` and `presence_update { userId, online: false }` to every conversation room.

Events are only emitted if the user has an active WebSocket connection (checked via Redis). No events are emitted if the user is currently offline.

### Error responses

| Status | Body | Condition |
|---|---|---|
| `400` | `{ "error": "Username must be 3-30 alphanumeric characters and underscores only" }` | `username` fails regex `/^[a-zA-Z0-9_]{3,30}$/` |
| `400` | `{ "error": "presenceVisible must be a boolean" }` | `presenceVisible` is provided but is not a strict `boolean` |
| `404` | `{ "error": "User not found" }` | The authenticated user no longer exists after the update attempt |
| `409` | `{ "error": "Username is already taken" }` | `username` is in use by a different user |
| `409` | `{ "error": "Username conflict or database error" }` | Unexpected database error (e.g., race-condition conflict not caught by the pre-check) |

---

## GET /users/:id

Fetch a public profile of any user by their UUID. Exposes a reduced set of fields compared to `GET /users/me` — `presenceVisible` and `createdAt` are not included.

### Request

```
GET /users/:id
Authorization: Bearer <jwt>
```

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string (UUID) | Target user's ID |

### Success response — `200 OK`

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "username": "alice",
  "avatarUrl": "https://example.com/alice.png",
  "wallets": [
    { "address": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE", "isPrimary": true },
    { "address": "GHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJK", "isPrimary": false }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID) | |
| `username` | `string \| null` | |
| `avatarUrl` | `string \| null` | |
| `wallets` | `Array<{ address: string, isPrimary: boolean }>` | All linked wallets |

Internal fields (`createdAt`, `updatedAt`, wallet `id`/`userId`/`createdAt`) are explicitly stripped by the handler and never appear in the response.

### Error responses

| Status | Body | Condition |
|---|---|---|
| `404` | `{ "error": "User not found" }` | No user with that ID exists, or the database query threw (e.g. malformed UUID) |

---

## GET /users/:id/presence

Query the real-time or last-seen presence status of a user. Respects the target user's `presenceVisible` privacy setting.

### Request

```
GET /users/:id/presence
Authorization: Bearer <jwt>
```

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string (UUID) | Target user's ID |

### Presence resolution logic

The server applies the following ordered strategy:

1. **Privacy check:** Load `presenceVisible` for the target user. If `presenceVisible = false`, return `{ "online": "unknown" }` immediately — no further lookup is performed.
2. **Redis (WebSocket connections):** If Redis is available, check whether the user has any active socket connections (`presence:user:<userId>` hash in Redis, TTL 90 s). If any exist → `{ "online": true }`.
3. **Device database fallback:** If Redis is unavailable or returns no active connections, query the `devices` table. A user is considered online if any non-revoked device has `lastSeenAt` within the last **90 seconds**. If found → `{ "online": true }`. Otherwise → `{ "online": false, "lastSeen": "<ISO-8601 timestamp or null>" }` using the most recent `lastSeenAt` across all non-revoked devices.

### Success responses — `200 OK`

**Presence hidden (user opted out):**
```json
{ "online": "unknown" }
```

**User is online (Redis or device check):**
```json
{ "online": true }
```

**User is offline — `lastSeen` known:**
```json
{ "online": false, "lastSeen": "2026-05-31T09:00:00.000Z" }
```

**User is offline — no `lastSeen` available:**
```json
{ "online": false }
```

| Field | Type | Notes |
|---|---|---|
| `online` | `true \| false \| "unknown"` | `"unknown"` when the user has disabled presence visibility |
| `lastSeen` | `string` (ISO 8601) — optional | Only present when `online: false` and at least one device has a recorded `lastSeenAt` |

### Error responses

| Status | Body | Condition |
|---|---|---|
| `404` | `{ "error": "User not found" }` | No user with that ID exists |

---

## GET /users/:id/key-fingerprint

Compute and return the **safety number** (key fingerprint) for a user. The fingerprint is a 60-digit numeric string derived deterministically from all of the user's active device identity public keys. Clients can independently cross-check this value to verify that no man-in-the-middle has substituted a device key.

### Request

```
GET /users/:id/key-fingerprint
Authorization: Bearer <jwt>
```

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string (UUID) | Target user's ID |

### Success response — `200 OK`

```json
{
  "userId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "fingerprint": "123456789012345678901234567890123456789012345678901234567890",
  "formatted": "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
}
```

| Field | Type | Notes |
|---|---|---|
| `userId` | `string` (UUID) | Echoes the path parameter |
| `fingerprint` | `string` | Raw 60-digit decimal string (no spaces) |
| `formatted` | `string` | 12 groups of 5 digits, space-separated (Signal safety number display format) |

`fingerprint` and `formatted` encode the same number. Clients should strip spaces before comparing: `formatted.replace(/ /g, '') === fingerprint`.

### Derivation algorithm — client cross-check specification

The server computation is fully deterministic and reproducible client-side. Steps:

**Step 1 — Collect keys**  
Collect all `identityPublicKey` values from the `devices` table where `userId = <id>` AND `revokedAt IS NULL`. These are base64-encoded Ed25519 public keys (one per registered, non-revoked device).

**Step 2 — Sort lexicographically**  
Sort the collected key strings by UTF-8 byte-order (standard JavaScript/Unicode string comparison). This ensures the fingerprint is independent of the order in which devices were registered.

```
sorted = keys.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
```

**Step 3 — Concatenate with newline separator**  
Join the sorted key strings with a single newline character (`\n`, U+000A) between each key. No trailing newline.

```
concatenated = sorted.join('\n')
```

**Step 4 — SHA-256**  
Compute SHA-256 of the UTF-8 encoding of the concatenated string. The resulting digest is exactly 32 bytes.

```
digest = SHA256(UTF8(concatenated))   // 32-byte Buffer
```

**Step 5 — Extract Segment A (digits 1–30)**  
Take bytes at indices `[0, 14]` inclusive — 15 bytes (120 bits). Interpret them as a big-endian unsigned integer. Reduce modulo 10³⁰. Zero-pad left to exactly 30 decimal digits.

```
valueA = BigInt(digest[0..14], big-endian)
segmentA = (valueA % 10n**30n).toString().padStart(30, '0')
```

**Step 6 — Extract Segment B (digits 31–60)**  
Take bytes at indices `[15, 29]` inclusive — 15 bytes. Apply the same reduction.

```
valueB = BigInt(digest[15..29], big-endian)
segmentB = (valueB % 10n**30n).toString().padStart(30, '0')
```

The two 15-byte windows are non-overlapping within the 32-byte digest (indices 0–14 and 15–29), providing two statistically independent segments.

**Step 7 — Concatenate segments**  
```
fingerprint = segmentA + segmentB   // 60 digits
```

**Step 8 — Format for display**  
Split the 60-digit string into groups of 5 and join with spaces:
```
formatted = fingerprint.match(/.{5}/g).join(' ')
// → "XXXXX XXXXX ... XXXXX"  (12 groups of 5, 11 spaces)
```

**Derivation notes:**
- The algorithm matches Signal's safety-number scheme — two independent 30-digit numbers from non-overlapping digest halves.
- The identity keys used as input are the **base64 string representations** stored in the database. Clients must use the same encoding they submitted during device registration.
- Revoked devices are excluded from the computation. A new fingerprint must be fetched (and re-verified out-of-band) whenever the user's active device set changes.
- A single-device user produces a valid 60-digit fingerprint from just one key.

### Error responses

| Status | Body | Condition |
|---|---|---|
| `404` | `{ "error": "User not found" }` | No user with that ID exists |
| `404` | `{ "error": "No active devices found for this user" }` | User exists but has zero non-revoked devices |
| `500` | `{ "error": "Failed to compute key fingerprint" }` | Unexpected error during computation |

---

## GET /users/:userId/devices/:deviceId/key-bundle

Fetch the X3DH prekey bundle for a specific device. This is the primary entry point for session establishment (Extended Triple Diffie-Hellman). The endpoint atomically claims and marks consumed **one** one-time prekey (OTP) so it can never be handed out to a second caller. If the device has no remaining OTPs the endpoint falls back to a signed-prekey-only bundle — the caller performs 3-DH instead of 4-DH.

> **Scope:** This route is the **other-user-facing** bundle lookup. Callers use it to establish a session with a device they do not own. To list or manage their **own** devices' prekeys, callers use `GET /devices` (the devices router).  
> Security invariant: `:userId` must be the actual owner of `:deviceId`; mismatches return `404`, preventing device enumeration across users.

### Request

```
GET /users/:userId/devices/:deviceId/key-bundle
Authorization: Bearer <jwt>
```

| Parameter | In | Type | Description |
|---|---|---|---|
| `userId` | path | string (UUID) | ID of the user who owns the target device |
| `deviceId` | path | string (UUID) | ID of the specific device to fetch a bundle for |

No query parameters or request body.

### Success response — `200 OK`

**Full bundle (OTP available):**

```json
{
  "deviceId": "b8e6f1a2-0c4d-4e5f-a6b7-c8d9e0f1a2b3",
  "identityPublicKey": "base64-encoded-ed25519-public-key==",
  "registrationId": 1234,
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64-encoded-signed-prekey-public==",
    "signature": "base64-encoded-ed25519-signature-over-public-key=="
  },
  "oneTimePreKey": {
    "keyId": 42,
    "publicKey": "base64-encoded-one-time-prekey-public=="
  }
}
```

**Fallback bundle (OTPs exhausted):**

```json
{
  "deviceId": "b8e6f1a2-0c4d-4e5f-a6b7-c8d9e0f1a2b3",
  "identityPublicKey": "base64-encoded-ed25519-public-key==",
  "registrationId": 1234,
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64-encoded-signed-prekey-public==",
    "signature": "base64-encoded-ed25519-signature-over-public-key=="
  },
  "oneTimePreKey": null
}
```

| Field | Type | Notes |
|---|---|---|
| `deviceId` | `string` (UUID) | Device identifier; echoes `:deviceId` |
| `identityPublicKey` | `string` (base64) | Long-term Ed25519 identity public key for the device |
| `registrationId` | `integer \| null` | X3DH/Signal registration ID set by the device during auth; `null` if not provided at registration |
| `signedPreKey.keyId` | `integer` | Application-assigned ID for this signed prekey |
| `signedPreKey.publicKey` | `string` (base64) | Signed prekey's public component |
| `signedPreKey.signature` | `string` (base64) | Ed25519 signature over `signedPreKey.publicKey`, signed by the device's `identityPublicKey`. **Callers must verify this before using the signed prekey.** |
| `oneTimePreKey` | `object \| null` | Present and non-null when an OTP was successfully claimed; `null` when the device has no remaining OTPs |
| `oneTimePreKey.keyId` | `integer` | Application-assigned ID for the consumed OTP |
| `oneTimePreKey.publicKey` | `string` (base64) | Consumed OTP's public component |

### OTP consumption semantics — atomic and race-free

The one-time prekey selection and consumption happen inside a **single serialisable database transaction** with a pessimistic row-level lock, ensuring that no two concurrent callers can receive the same OTP:

```
BEGIN TRANSACTION
  SELECT id, keyId, publicKey
    FROM device_prekeys
   WHERE deviceId = :deviceId
     AND keyType  = 'one_time'
     AND consumed = false
   ORDER BY createdAt ASC       -- oldest first (FIFO)
   LIMIT 1
   FOR UPDATE SKIP LOCKED;      -- skip rows locked by a concurrent claim

  IF candidate found:
    UPDATE device_prekeys SET consumed = true WHERE id = candidate.id;
    RETURN { keyId, publicKey }
  ELSE:
    RETURN null
COMMIT
```

**Key properties:**

| Property | Detail |
|---|---|
| **Atomic claim** | The `SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE consumed = true` execute in a single transaction. A committed claim is final — the row is never deleted. |
| **Race-free** | `SKIP LOCKED` means concurrent transactions bypass a row that another transaction has locked, so two simultaneous bundle fetches will each claim a distinct OTP or observe exhaustion independently — neither blocks the other and neither can claim the same row. |
| **Audit trail** | `consumed` is flipped to `true`; the row is never deleted. The `device_prekeys_one_time_available_idx` partial index (`keyType = 'one_time' AND consumed = false`) keeps unconsumed key lookups efficient. |
| **FIFO ordering** | OTPs are consumed in upload order (`ORDER BY createdAt ASC`). The oldest unconsumed key is always selected first. |
| **Graceful null-OTP fallback** | If the transaction finds no unconsumed OTP (exhausted supply), it returns `null` for `oneTimePreKey`. The server responds `200 OK` — not an error — with a signed-prekey-only bundle. The initiator must then perform **3-DH** (identity key + signed prekey only) rather than **4-DH** (identity key + signed prekey + one-time prekey). No `UPDATE` is executed in the exhausted case (verified by the test suite: `tx.update` is not called). |

**Client handling for `oneTimePreKey: null`:**

- Treat the absence of an OTP as a reduced-entropy session establishment, not a failure.
- Proceed with 3-DH using `identityPublicKey` and `signedPreKey` alone.
- If possible, surface a UX nudge to the recipient prompting them to replenish their OTP supply (upload new one-time prekeys via `POST /devices/:id/prekeys`).

**Replenishment:** OTPs are uploaded by the device owner via `POST /devices/:id/prekeys`. Up to 200 unconsumed OTPs may be stored per device at any time.

### Error responses

| Status | Body | Condition |
|---|---|---|
| `404` | `{ "error": "Device not found or has been revoked" }` | `:deviceId` does not exist, its `userId` does not match `:userId`, or `revokedAt IS NOT NULL` |
| `409` | `{ "error": "Device has not uploaded a signed prekey yet" }` | The device exists and is active but has not yet uploaded a signed prekey; a session cannot be established |

> **Note on 404 ambiguity:** The route intentionally returns the same `404` body for "device not found", "wrong owner", and "device revoked". This prevents callers from distinguishing between these cases, which would otherwise enable device enumeration across users.

---

## Common status codes

| Status | Meaning |
|---|---|
| `200` | Success |
| `400` | Client error — invalid input (missing required param, type mismatch, validation failure) |
| `401` | Unauthenticated — see [Authentication](#authentication) |
| `404` | Resource not found |
| `409` | Conflict — typically a uniqueness violation or a precondition not yet met |
| `500` | Unexpected server error |

---

## Data model reference

The following database tables underpin the routes documented here. Full schema: `apps/backend/src/db/schema.ts`.

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `username` | text (unique, nullable) | Set via `PATCH /users/me` |
| `avatarUrl` | text (nullable) | |
| `presenceVisible` | boolean | Default `true`. Controls whether `GET /users/:id/presence` reveals the real status |
| `sendReadReceipts` | boolean | Default `true`. Privacy setting — whether the user allows sending read receipts to others. Included in `PATCH /users/me` responses (via unfiltered `.returning()`) but not in `GET /users/me` |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### `wallets`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `userId` | UUID FK → `users.id` | Cascades on delete |
| `address` | text (unique) | Stellar public key |
| `isPrimary` | boolean | At most one primary wallet per user |

### `devices`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `userId` | UUID FK → `users.id` | |
| `identityPublicKey` | text | Base64-encoded Ed25519 public key. Unique per `(userId, identityPublicKey)` pair |
| `registrationId` | integer (nullable) | X3DH registration ID |
| `deviceName` | text (nullable) | |
| `platform` | enum (`web`, `ios`, `android`) | |
| `lastSeenAt` | timestamp (nullable) | Updated on auth and heartbeat |
| `pushEnabled` | boolean | |
| `revokedAt` | timestamp (nullable) | Non-null → device is revoked |

### `device_prekeys`

Signed and one-time prekeys share this table, discriminated by `keyType`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `deviceId` | UUID FK → `devices.id` | Cascades on delete |
| `keyType` | enum (`signed`, `one_time`) | |
| `keyId` | integer | Application-assigned. Unique per `(deviceId, keyType, keyId)` |
| `publicKey` | text | Base64-encoded public key |
| `signature` | text (nullable) | Required when `keyType = 'signed'`; enforced by DB check constraint |
| `consumed` | boolean | Default `false`. Flipped to `true` atomically when an OTP is claimed by the key-bundle endpoint |
| `createdAt` | timestamp | |

**Unique indexes relevant to this router:**

- `device_prekeys_signed_device_idx` — partial unique on `deviceId` where `keyType = 'signed'`: enforces exactly one active signed prekey per device.
- `device_prekeys_device_type_keyid_idx` — unique on `(deviceId, keyType, keyId)`: prevents duplicate key uploads.
- `device_prekeys_one_time_available_idx` — partial index on `deviceId` where `keyType = 'one_time' AND consumed = false`: makes unconsumed OTP selection in the key-bundle transaction fast.

---

## Implementation references

| File | Purpose |
|---|---|
| [`apps/backend/src/routes/users.ts`](../src/routes/users.ts) | All routes documented here |
| [`apps/backend/src/middleware/auth.ts`](../src/middleware/auth.ts) | `requireAuth` — JWT validation + device revocation check |
| [`apps/backend/src/db/schema.ts`](../src/db/schema.ts) | `users`, `wallets`, `devices`, `devicePrekeys` table definitions |
| [`apps/backend/src/services/presence.ts`](../src/services/presence.ts) | `isOnline`, `deriveDevicePresence` — presence resolution helpers |
| [`apps/backend/src/__tests__/users.test.ts`](../src/__tests__/users.test.ts) | Tests for `/me`, `/:id`, `/search`, `/presence`, `PATCH /me` |
| [`apps/backend/src/__tests__/users.bundle.test.ts`](../src/__tests__/users.bundle.test.ts) | Tests for the key-bundle endpoint and OTP consumption |
| [`apps/backend/src/__tests__/users.fingerprint.test.ts`](../src/__tests__/users.fingerprint.test.ts) | Tests for the key-fingerprint derivation and output format |
| [`apps/backend/docs/e2ee-onboarding.md`](./e2ee-onboarding.md) | End-to-end onboarding sequence; covers `POST /auth/verify`, prekey upload, and bundle fetch ordering |
