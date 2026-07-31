# E2EE onboarding sequence

This document describes the backend E2EE onboarding flow implemented today for device registration and prekey upload, and how a client should sequence first-contact DM setup on top of those APIs.

It covers:

1. happy path
2. offline-recipient path
3. prekey-exhausted path

It also records the exact request/response JSON shapes implemented by the current backend endpoints and the ordering guarantees clients can rely on.

## Scope and current backend surface

The currently implemented backend endpoints involved in onboarding are:

- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /devices`
- `POST /devices/:id/prekeys`
- `GET /users/:userId/devices/:deviceId/key-bundle` — fetches another user's device
  bundle (identity key + signed prekey + one atomically-consumed one-time prekey)

There is **currently no implemented backend endpoint in this repo** for:

- server-side session creation
- sending encrypted DM envelopes

Those later steps are part of the intended product flow, but they are not exposed by implemented backend routes in `apps/backend/src/routes` yet. This doc therefore does two things:

- documents the **exact JSON that exists now** for onboarding/device-prekey registration
- documents the **required sequencing and guarantees** for first-DM bundle fetch/session/envelope send so future endpoints preserve compatibility with the existing implementation

## Actors

- **Sender client**: the device initiating onboarding or first DM
- **Recipient client**: the target device/user for a first DM
- **Backend API**: Express app in `apps/backend/src/routes`

## Implemented data model

The implemented E2EE-related tables are defined in `apps/backend/src/db/schema.ts`.

### Device

A device row is created during `POST /auth/verify` keyed by `(userId, identityPublicKey)`.

Stored shape:

```json
{
  "id": "uuid",
  "userId": "uuid",
  "identityPublicKey": "base64-ed25519-spki-der",
  "isRevoked": false,
  "createdAt": "timestamp",
  "updatedAt": "timestamp"
}
```

Notes:

- `identityPublicKey` is the long-term device identity public key.
- device lookup during verify is by `userId + identityPublicKey`
- revoked devices cannot sign in again

### Signed prekey

Exactly one signed prekey is stored per device.

Stored shape:

```json
{
  "id": "uuid",
  "deviceId": "uuid",
  "keyId": 1,
  "publicKey": "base64",
  "signature": "base64",
  "createdAt": "timestamp"
}
```

Notes:

- uniqueness is enforced on `deviceId`
- uploading replaces the previous signed prekey for that device

### One-time prekey

Stored shape:

```json
{
  "id": "uuid",
  "deviceId": "uuid",
  "keyId": 10,
  "publicKey": "base64",
  "createdAt": "timestamp"
}
```

Notes:

- uniqueness is enforced on `(deviceId, keyId)`
- max stored one-time prekeys per device is `200`
- duplicate uploads are ignored on conflict

## Exact implemented endpoint JSON

### 1) Client requests auth challenge

Endpoint:

```text
POST /auth/challenge
```

Request JSON:

```json
{
  "walletAddress": "G..."
}
```

Response JSON:

```json
{
  "message": "Sign in to Clicked\nWallet: G...\nNonce: abc123",
  "nonce": "abc123"
}
```

Ordering guarantees:

- client must call this before `POST /auth/verify`
- returned `nonce` must be echoed unchanged to `POST /auth/verify`
- the backend consumes the nonce during verify, so the same nonce is single-use from the client's perspective

### 2) Client verifies wallet signature and registers/resolves device

Endpoint:

```text
POST /auth/verify
```

Request JSON:

```json
{
  "walletAddress": "G...",
  "signature": "signature-string",
  "nonce": "abc123",
  "identityPublicKey": "base64-ed25519-spki-der"
}
```

Success response JSON:

```json
{
  "token": "jwt"
}
```

Possible error JSON:

```json
{ "error": "Invalid or expired nonce" }
```

```json
{ "error": "Signature verification failed" }
```

```json
{ "error": "Invalid signature or wallet address" }
```

```json
{ "error": "Device has been revoked" }
```

```json
{ "error": "Failed to create user" }
```

```json
{ "error": "Failed to register device" }
```

Behavior and guarantees:

1. nonce is validated and consumed first
2. wallet signature is verified second
3. user and wallet are resolved/upserted third
4. device is resolved by `(userId, identityPublicKey)` fourth
5. if no device exists, a new device row is inserted
6. returned JWT includes the backend device row id as `deviceId`

Important ordering guarantee:

- a client must not attempt `POST /devices/:id/prekeys` until it has successfully completed `POST /auth/verify` and extracted the authenticated device id from the returned JWT context

## Replay protection model

Clicked applies replay defenses at three layers so retries stay safe while stale
or duplicated payloads are rejected:

1. **Auth nonce (`POST /auth/challenge` → `POST /auth/verify`)**
   - each challenge nonce is bound to the wallet address that requested it
   - the nonce is single-use and expires after 5 minutes
   - `POST /auth/verify` consumes the nonce before signature verification, so a
     captured auth payload cannot be replayed after the first successful submit
2. **Socket dispatch envelopes (`dispatch`)**
   - every envelope must include a unique `eventId` and a client `timestamp`
   - the backend stores each accepted `eventId` for 24 hours and drops later
     duplicates without re-running the handler
   - the backend rejects envelopes older than 5 minutes or more than 30 seconds
     in the future to narrow the replay window for intercepted payloads
3. **Message persistence (`messageId`)**
   - `POST /messages`, `send_message`, `edit_message`, and `send_file_message`
     require a client-generated `messageId`
   - if the same `messageId` arrives again, the backend treats it as an
     idempotent retry and returns the original ack/created timestamp instead of
     inserting a duplicate row

Operational guidance:

- retries must reuse the original `eventId`/`messageId`
- new user actions must generate fresh ids
- client clocks should stay reasonably accurate; overly stale or future-dated
  dispatch envelopes are rejected even if their signature/auth data is valid

## How the device id is obtained after verify

`POST /auth/verify` returns only:

```json
{
  "token": "jwt"
}
```

The backend signs the token with payload fields including:

```json
{
  "userId": "uuid",
  "walletAddress": "G...",
  "deviceId": "uuid"
}
```

So the authenticated device id used in subsequent calls is the `deviceId` embedded in the JWT.

## 3) Client uploads prekeys

Endpoint:

```text
POST /devices/:id/prekeys
```

Auth:

```text
Authorization: Bearer <jwt-from-auth-verify>
```

Path parameter:

- `:id` must be the authenticated backend device row id from the JWT

Request JSON:

```json
{
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64",
    "signature": "base64"
  },
  "oneTimePreKeys": [
    {
      "keyId": 10,
      "publicKey": "base64"
    },
    {
      "keyId": 11,
      "publicKey": "base64"
    }
  ]
}
```

Success response JSON:

```json
{
  "uploadedSignedPreKey": true,
  "uploadedOneTimePreKeys": 2,
  "capped": false
}
```

Success response when batch is trimmed by the cap:

```json
{
  "uploadedSignedPreKey": true,
  "uploadedOneTimePreKeys": 1,
  "capped": true
}
```

Possible error JSON:

```json
{ "error": "Device not found" }
```

```json
{ "error": "Only the device owner may upload prekeys" }
```

```json
{ "error": "Device is revoked" }
```

```json
{ "error": "Signed prekey signature is invalid" }
```

```json
{ "error": "One-time prekey cap of 200 reached. Consume existing prekeys before uploading more." }
```

Validation constraints:

- `signedPreKey.keyId` is a non-negative integer
- `signedPreKey.publicKey` is required
- `signedPreKey.signature` is required
- `oneTimePreKeys` must contain at least one item
- each one-time prekey must include non-negative integer `keyId` and required `publicKey`

Behavior and guarantees:

1. authenticated caller is checked first
2. referenced device row is loaded second
3. ownership is enforced third
4. revoked devices are rejected fourth
5. signed prekey signature is verified against `device.identityPublicKey` fifth
6. current one-time prekey count is checked sixth
7. signed prekey upsert runs before one-time prekey inserts
8. one-time prekeys are inserted with conflict-ignore semantics
9. response reports how many one-time prekeys from the incoming batch were accepted after cap trimming

Important ordering guarantees:

- signed prekey upload and one-time prekey upload happen in a single request
- the device's signed prekey is always written before any one-time prekey insert in handler order
- if the device already has `200` one-time prekeys stored, the request is rejected with `422` and nothing new is uploaded
- if the incoming batch would exceed the cap, the server trims the batch to fit the remaining slots instead of rejecting the whole request
- duplicate one-time prekeys by `(deviceId, keyId)` are ignored by the database conflict rule

## Sequence: happy path

This is the intended first-time onboarding and first-DM path.

```text
Client                           Backend                          Recipient state
  |                                 |                                   |
  |-- POST /auth/challenge -------->|                                   |
  |<- { message, nonce } -----------|                                   |
  |                                 |                                   |
  |-- sign challenge locally -------|                                   |
  |                                 |                                   |
  |-- POST /auth/verify ----------->|                                   |
  |   { walletAddress, signature,   |                                   |
  |     nonce, identityPublicKey }  |                                   |
  |<- { token } --------------------|                                   |
  |                                 |                                   |
  |-- derive deviceId from JWT -----|                                   |
  |                                 |                                   |
  |-- POST /devices/:id/prekeys --->|                                   |
  |   { signedPreKey,               |                                   |
  |     oneTimePreKeys[] }          |                                   |
  |<- { uploadedSignedPreKey,       |                                   |
  |     uploadedOneTimePreKeys,     |                                   |
  |     capped } -------------------|                                   |
  |                                 |                                   |
  |-- GET /users/:uid/devices/ ---->|      resolves via #133 fanout     |
  |     :did/key-bundle             |      for the full device set      |
  |<- recipient bundle -------------|                                   |
  |                                 |                                   |
  |-- establish session locally ----|                                   |
  |                                 |                                   |
  |-- send encrypted envelopes ---->|      DM send path separate        |
  |                                 |                                   |
```

### Recipient bundle shape required for first DM

`GET /users/:userId/devices/:deviceId/key-bundle` returns one device's bundle per
call (callers loop over the recipient's active device list — see
`GET /conversations/:id/devices` — to build an envelope per device):

```json
{
  "deviceId": "uuid",
  "identityPublicKey": "base64-ed25519-spki-der",
  "registrationId": 1234,
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64",
    "signature": "base64"
  },
  "oneTimePreKey": {
    "keyId": 10,
    "publicKey": "base64"
  }
}
```

`:userId` must match the target device's actual owner or the endpoint returns
`404` — this route intentionally cannot be used to enumerate another user's
devices without already knowing both ids.

Client expectations for the happy path:

1. fetch each recipient device's bundle after sender has uploaded its own prekeys
2. use recipient `identityPublicKey`
3. verify recipient `signedPreKey.signature` against recipient `identityPublicKey`
4. use a consumed recipient `oneTimePreKey` if present
5. establish the initial session locally
6. encrypt one envelope per recipient device and send them through the messaging path

## Sequence: offline-recipient path

In the offline-recipient path, the recipient client is not connected, but has already onboarded and uploaded prekeys.

```text
Sender client                     Backend                          Recipient client
  |                                 |                                   |
  |-- fetch recipient bundle ------>|                                   |
  |<- bundle with signedPreKey -----|                                   |
  |   and oneTimePreKey             |                                   |
  |                                 |                                   |
  |-- establish session locally ----|                                   |
  |                                 |                                   |
  |-- send encrypted envelopes ---->|---- stores/queues envelopes ----->|
  |                                 |                                   |
  |                                 |<--- recipient later comes online --|
  |                                 |---- recipient receives envelope -->|
```

Required guarantees for this path:

- recipient need not be online if the backend can return a valid bundle with at least identity key + signed prekey
- bundle fetch must reserve or consume at most one one-time prekey per recipient device for the session-init message
- envelope send must be durable enough for later delivery

How this maps to the implemented code today:

- the preconditions for offline delivery already exist: device identity keys, one signed prekey per device, and a stock of one-time prekeys per device
- the bundle-fetch route (`GET /users/:userId/devices/:deviceId/key-bundle`) is implemented; envelope storage/queueing for offline recipients is handled by the message-send + sync path (`GET /sync`), documented separately

## Sequence: prekey-exhausted path

This path happens when the recipient has no one-time prekeys left, or when a sender-side device has reached the upload cap and needs replenishment handling.

### A) Sender upload cap exhausted

This part is implemented today.

```text
Client                           Backend
  |                                 |
  |-- POST /devices/:id/prekeys --->|
  |                                 |
  |<- 422 { error: "One-time       -|
  |          prekey cap of 200      |
  |          reached..." }          |
```

Client behavior:

- do not retry the same upload blindly
- wait until existing one-time prekeys have been consumed, or rotate strategy client-side
- if partial capacity remains, respect `uploadedOneTimePreKeys` and `capped: true`

### B) Recipient one-time prekeys exhausted

This recipient-side fetch path is implemented — `GET /users/:userId/devices/:deviceId/key-bundle`
returns `oneTimePreKey: null` (rather than erroring) once a device's one-time
prekeys are exhausted, so the sender falls back to a 3-DH session:

```text
Sender client                     Backend
  |                                 |
  |-- GET .../key-bundle ---------->|
  |<- bundle with identity key -----|
  |   + signed prekey only          |
  |   + oneTimePreKey: null         |
  |                                 |
  |-- establish fallback session ---|
  |   using signed prekey only      |
  |                                 |
  |-- send prekey envelope -------->|
```

Actual JSON shape for the prekey-exhausted bundle response:

```json
{
  "deviceId": "uuid",
  "identityPublicKey": "base64-ed25519-spki-der",
  "registrationId": 1234,
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64",
    "signature": "base64"
  },
  "oneTimePreKey": null
}
```

Required guarantees for this path:

- absence of a one-time prekey must be explicit, not ambiguous
- signed prekey must still be present if the device remains reachable for session bootstrap
- client must treat this as lower-entropy/fallback first-contact establishment and should trigger recipient prekey replenishment UX when possible

### C) Low-prekey warning before exhaustion

Waiting for exhaustion means every sender in the meantime is downgraded to
3-DH, so the backend warns the owning device *before* it runs dry.

Two surfaces expose this:

1. `GET /devices` returns `oneTimePreKeysRemaining` per device — a count of
   unconsumed one-time prekeys, `0` when the device has none. Poll-free clients
   can read this at startup to decide whether to top up.
2. A `prekeys_low` Socket.IO event is emitted after a bundle fetch drops a
   device below the threshold (default `20`, overridable with the
   `PREKEY_LOW_THRESHOLD` env var).

Event payload:

```json
{
  "deviceId": "uuid",
  "oneTimePreKeysRemaining": 19,
  "threshold": 20
}
```

Delivery and debounce semantics:

- emitted only to the `device:{deviceId}` room — the owning device, on whichever
  gateway holds its socket. No other device on the account sees it, since only
  the owner can generate replacement prekeys.
- fired **at most once per threshold crossing**. A device that keeps serving
  bundles while below the threshold is told once, not once per fetch.
- the signal re-arms when `POST /devices/:id/prekeys` brings the device back to
  or above the threshold, so a later crossing warns again. Revoking a device
  also re-arms it (its prekeys are deleted).
- a device that is offline when the threshold is crossed misses the event; it
  should read `oneTimePreKeysRemaining` from `GET /devices` on reconnect.

Client behavior:

- on `prekeys_low`, generate and upload a fresh batch via
  `POST /devices/:id/prekeys`, respecting the `200` cap
- the upload response echoes `oneTimePreKeysRemaining` so the client can confirm
  it is back above the threshold without a follow-up `GET /devices`

## End-to-end ordering contract

For compatibility with the current implementation, clients should rely on this ordering:

1. generate local identity keypair
2. call `POST /auth/challenge`
3. sign the challenge message with the wallet
4. call `POST /auth/verify` with `identityPublicKey`
5. receive JWT containing backend `deviceId`
6. call `POST /devices/:deviceId/prekeys`
7. only after successful prekey upload, attempt first-DM recipient bundle fetch via `GET /users/:userId/devices/:deviceId/key-bundle`
8. establish session locally from recipient bundle
9. send encrypted envelope(s)

### Ordering rules clients can assume today

- a device cannot upload prekeys before it has authenticated and been resolved to a backend device id
- a revoked device cannot authenticate or upload prekeys
- a signed prekey is validated against the stored device identity key before it is accepted
- one-time prekeys are capped at 200 stored keys per device
- prekey upload returns the accepted count so the client can reconcile local inventory

## Implementation references

- auth challenge/verify: `apps/backend/src/routes/auth.ts`
- auth request schema: `apps/backend/src/schemas/auth.schemas.ts`
- device registration/listing/revocation/prekey upload: `apps/backend/src/routes/devices.ts`
- recipient key-bundle fetch: `apps/backend/src/routes/users.ts` (`GET /users/:userId/devices/:deviceId/key-bundle`)
- E2EE-related schema: `apps/backend/src/db/schema.ts` (`devices`, `devicePrekeys`)
- low-prekey signal + debounce latch: `apps/backend/src/services/prekeyLowSignal.ts`
- prekey route tests: `apps/backend/src/__tests__/devices.prekeys.test.ts`
- key-bundle route tests: `apps/backend/src/__tests__/users.bundle.test.ts`
- low-prekey signal tests: `apps/backend/src/__tests__/prekeysLow.test.ts`

## Gaps to close for full first-DM support

Recipient bundle fetch and atomic one-time prekey consumption are implemented
(see above). Backend work still needed for full first-DM support:

- encrypted envelope submit/store/deliver for the *first* contact between two
  users specifically (the general send path exists — see `docs/` for the
  message/envelope model — but hasn't been audited end-to-end against this
  onboarding sequence)
- explicit multi-device fanout semantics for first-contact DM

This document is written so that work can build on the already-implemented onboarding JSON and ordering contract without changing it.
