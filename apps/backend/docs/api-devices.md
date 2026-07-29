# Devices & Prekeys API

Audience: **downstream integrators** — client developers implementing device
registration, prekey publishing, and device management against this backend.

This document describes every route mounted under `/devices`
(`src/routes/devices.ts`) and the single legacy-alias route mounted under
`/user-devices` (`src/routes/userDevices.ts`), verified against the current
implementation of both files. All routes require authentication
(`requireAuth`) — a request with a missing/invalid `Authorization` header, an
expired/invalid token, or a token for a revoked device returns `401` before
any route-specific logic runs.

`devices` is the single canonical device registry. A previously-separate
`user_devices` table was merged into it so the realtime/messaging/push layer
and the auth/prekey layer share one source of truth; `userDevices.ts` only
exposes a public-key lookup now, not a separate device store.

## Table of contents

- [GET /devices](#get-devices) — list the caller's devices
- [POST /devices](#post-devices) — register a new device
- [DELETE /devices/:id](#delete-devicesid) — revoke a single device
- [POST /devices/logout-everywhere](#post-deviceslogout-everywhere) — revoke every other device
- [POST /devices/:id/prekeys](#post-devicesidprekeys) — upload prekeys
- [GET /user-devices/:id/public-key](#get-user-devicesidpublic-key) — legacy alias
- [Revocation side effects](#revocation-side-effects) (shared by `DELETE /:id` and `logout-everywhere`)
- [Prekey upload contract](#prekey-upload-contract) (signed vs. one-time, cap, trimming)

---

## `GET /devices`

Lists every device belonging to the caller's account (active and revoked),
active first, most recently created first.

**Auth:** caller's own devices only — scoped implicitly to `req.auth.userId`,
no ownership parameter to check.

**Request:** no body.

**Response `200`:**
```json
[
  {
    "id": "b6b6c3b0-...",
    "identityPublicKey": "base64...",
    "deviceName": "Jesse's iPhone",
    "platform": "ios",
    "lastSeenAt": "2026-07-20T10:00:00.000Z",
    "revokedAt": null,
    "oneTimePreKeysRemaining": 47,
    "createdAt": "2026-06-01T12:00:00.000Z",
    "current": true
  }
]
```
- `oneTimePreKeysRemaining` — count of unconsumed `one_time` rows in
  `device_prekeys` for that device (`0` if none uploaded, or if the device
  has never had prekeys).
- `current` — `true` only for the device tied to the bearer token making the
  request (`req.auth.deviceId`).
- Ordering: `revokedAt IS NULL` devices first, then by `createdAt DESC`
  within each group.

**Response `500`:** `{ "error": "Failed to list devices" }` on unexpected
DB failure.

---

## `POST /devices`

Registers a new device for the authenticated user, or reactivates a
previously-revoked one.

**Auth:** caller registers a device against their own `userId`
(`req.auth.userId`) — there is no cross-user parameter.

**Request body** (validated by `RegisterDeviceSchema`, i.e. `DeviceSchema`):
```json
{
  "deviceName": "Jesse's iPhone",
  "platform": "ios",
  "identityPublicKey": "base64...",
  "registrationId": 12345
}
```
- `deviceName`: string, 1–100 chars, **required**.
- `platform`: one of `"web" | "ios" | "android"`, **required**.
- `identityPublicKey`: base64 Ed25519 public key, **required** (32 raw bytes,
  or 44-byte SPKI DER, per the shared key validator).
- `registrationId`: non-negative integer, **optional**.

**Behavior:**
- Looked up by `(userId, identityPublicKey)`.
- If a **non-revoked** row already exists for that identity key: `409`
  `{ "error": "Device already registered for this user" }`.
- If a **revoked** row exists for that identity key: it is reactivated in
  place (`deviceName`/`platform`/`registrationId` updated, `revokedAt` reset
  to `null`) rather than inserting a duplicate row for the same crypto
  identity.
- Otherwise: a new row is inserted.
- On success, a `device_added` key-change system event is emitted (see
  [Revocation side effects](#revocation-side-effects) for the event
  mechanism — registration reuses the same `emitDeviceChangeEvent` helper
  with `'device_added'` instead of `'device_revoked'`).

**Response `201`:**
```json
{ "id": "b6b6c3b0-...", "createdAt": "2026-07-29T10:00:00.000Z" }
```

**Response `409`:** device already registered (see above).

**Response `400`:** Zod validation failure —
```json
{
  "error": "Validation failed",
  "issues": [{ "field": "deviceName", "message": "deviceName is required" }]
}
```

**Response `500`:** `{ "error": "Failed to register device" }`.

---

## `DELETE /devices/:id`

Revokes a single device.

**Auth / ownership:** the device at `:id` must belong to the caller
(`device.userId === req.auth.userId`). A device that doesn't exist, or
belongs to someone else, returns the **same** `404` in both cases — the
route does not distinguish "not found" from "not yours" in its response, so
a caller cannot enumerate other users' device IDs by status code.

**Idempotency:** revoking an already-revoked device does **not** error — it
returns `200` with the existing `revokedAt` timestamp, confirming current
state rather than re-running side effects.

**Guard:** refuses to revoke a caller's **last remaining active device**
(there would be no way back into the account). Checked via a count of the
caller's non-revoked devices.

**Response `200`** (device revoked now, or already was):
```json
{ "id": "b6b6c3b0-...", "revokedAt": "2026-07-29T10:00:00.000Z" }
```

**Response `404`:** `{ "error": "Device not found" }` — device doesn't
exist, or isn't the caller's.

**Response `409`:** `{ "error": "Cannot revoke your only active device" }` —
caller has ≤1 active device.

See [Revocation side effects](#revocation-side-effects) below — this route
triggers the shared revocation path and, if the device was actually revoked
by this call (not already revoked), a `device_revoked` key-change event.

---

## `POST /devices/logout-everywhere`

Revokes **every other active device** on the caller's account — i.e. every
non-revoked device except the one making the request
(`req.auth.deviceId`). The calling device itself is left untouched.

**Auth:** implicit — operates on the caller's own account only.

**Request:** no body.

**Response `200`:**
```json
{ "revokedCount": 3 }
```
`revokedCount` is the number of devices actually revoked (excludes the
caller's current device, and excludes devices that were already revoked).

If `revokedCount > 0`, a single `device_revoked` key-change event is emitted
after all target devices have been revoked (not once per device).

See [Revocation side effects](#revocation-side-effects) — every device
revoked by this call goes through the identical per-device side effects as
`DELETE /:id` (prekey deletion, `device_revoked:*` publish, forced
disconnect).

---

## `POST /devices/:id/prekeys`

Uploads a signed prekey and a batch of one-time prekeys for a device the
caller owns.

**Auth / ownership:**
- Device must exist → otherwise `404` `{ "error": "Device not found" }`.
- Device must belong to the caller → otherwise `403`
  `{ "error": "Only the device owner may upload prekeys" }`.
- Device must **not** be revoked → otherwise `403`
  `{ "error": "Device is revoked" }`.

**Request body** (validated by a schema requiring both a signed prekey and
at least one one-time prekey):
```json
{
  "signedPreKey": {
    "keyId": 7,
    "publicKey": "base64...",
    "signature": "base64..."
  },
  "oneTimePreKeys": [
    { "keyId": 101, "publicKey": "base64..." },
    { "keyId": 102, "publicKey": "base64..." }
  ]
}
```
- `oneTimePreKeys` must contain **at least 1** entry — an empty array is a
  `400` schema-validation failure, not a no-op.
- `signedPreKey.signature` is verified as an Ed25519 signature over
  `signedPreKey.publicKey`, signed by the device's `identityPublicKey`. An
  invalid signature returns `400`
  `{ "error": "Signed prekey signature is invalid" }` and nothing is written.

See [Prekey upload contract](#prekey-upload-contract) below for the full
signed-vs-one-time distinction and the 200-key cap/trim behavior.

**Response `200`:**
```json
{
  "uploadedSignedPreKey": true,
  "uploadedOneTimePreKeys": 2,
  "capped": false
}
```

**Response `404`:** device not found.

**Response `403`:** not the owner, or device revoked.

**Response `400`:** signature invalid, or request body fails schema
validation.

**Response `422`:** `{ "error": "One-time prekey cap of 200 reached. Consume existing prekeys before uploading more." }` — the device already has 200 unconsumed one-time prekeys stored; the client must wait for some to be consumed before uploading more.

---

## `GET /user-devices/:id/public-key`

The one route in the legacy `userDevices.ts` router (mounted at
`/user-devices`). Returns another device's identity public key, for
encrypting to a sender you've received a message from.

**Auth / ownership:** this is a **cross-user** lookup, gated differently
from every other route on this page:
- The target device (`:id`) must exist **and be non-revoked** — a revoked
  or nonexistent device returns `404`
  `{ "error": "Device not found or revoked" }`.
- The caller must share **at least one conversation** with the target
  device's owner — otherwise `403`
  `{ "error": "No shared conversation with device owner" }`. There is no
  ownership requirement that the caller own the device itself; this route
  is explicitly for looking up *other* users' keys.

**Response `200`:**
```json
{
  "id": "b6b6c3b0-...",
  "userId": "3f2a1c9e-...",
  "identityPublicKey": "base64..."
}
```

**Response `404`:** device not found, or revoked.

**Response `403`:** caller shares no conversation with the device owner.

**Response `500`:** `{ "error": "Failed to fetch device public key" }`.

---

## Revocation side effects

`DELETE /:id` and `POST /logout-everywhere` both revoke devices through the
same shared helper, so every revocation — however it's triggered — has
**identical** effects per device:

1. **Row update:** `devices.revokedAt` is set to the current timestamp
   (`updatedAt` too). The row is not deleted — revoked devices remain
   visible via `GET /devices` with `revokedAt` set.
2. **Prekey deletion:** every row in `device_prekeys` for that device
   (signed **and** one-time, consumed or not) is deleted outright. A
   revoked device has no prekeys left to hand out; if it's ever
   re-registered (see `POST /devices` reactivation), it starts prekey-less
   and must re-upload.
3. **Live disconnect, same node:** `markDeviceRevoked(deviceId)` is called
   in-process to force-disconnect any live socket for that device on the
   node handling the request.
4. **Live disconnect, other nodes:** if Redis is configured, `1` is
   published to the `device_revoked:{deviceId}` channel so other backend
   nodes holding a live socket for that device also disconnect it
   cross-node. This publish is best-effort — a failure is swallowed
   (`.catch(() => {})`) and does not fail the HTTP request.
5. **Key-change system event:** after the revocation(s) complete, a
   `device_revoked` system event is emitted into every conversation the
   user is a member of — a `system`-content-type message is inserted per
   conversation, broadcast over the socket server to that conversation's
   room, and the affected members' conversation caches are invalidated.
   This is how other clients learn "this user's device set changed" so
   they can refresh key bundles. For `logout-everywhere`, this event fires
   **once** after the whole batch of devices is revoked, not once per
   device.

`POST /devices` (registration) uses the same event-emission helper, but
with a `device_added` change type instead — it does **not** run steps 1–4
(no prekey deletion or disconnects, since nothing is being revoked).

---

## Prekey upload contract

### Signed vs. one-time prekeys

| | Signed prekey | One-time prekeys |
|---|---|---|
| Count per device | Exactly one, upserted (replaced) on every upload | Many; new ones are added to the existing pool |
| Fields | `keyId`, `publicKey`, `signature` | `keyId`, `publicKey` |
| Conflict handling | `ON CONFLICT` on `(deviceId, keyType='signed')` → **updates** the existing row (`keyId`, `publicKey`, `signature`, `createdAt` all overwritten) | `ON CONFLICT` on `(deviceId, keyType, keyId)` → **ignored** (`onConflictDoNothing`); re-uploading the same `keyId` is a silent no-op, not an error |
| Signature check | `signature` is verified as an Ed25519 signature over `publicKey`, using the device's `identityPublicKey`. Invalid → `400`, nothing written | Not signature-checked individually |
| Consumption | Never marked `consumed` — it's reused across sessions | Each row has a `consumed` boolean; consumption itself happens outside this route (e.g. when another user fetches a key bundle) — this route only ever inserts unconsumed rows |

Every upload **replaces the signed prekey** (there is only ever one active
signed prekey per device) while **adding to** the one-time pool (existing
unconsumed one-time keys are left alone; new `keyId`s are appended).

### The 200-key cap and trimming behavior

Each device may have at most **200 unconsumed** one-time prekeys stored at
once (`OTP_CAP = 200`).

Before inserting, the endpoint counts the device's current unconsumed
`one_time` rows and computes `available = 200 - currentCount`:

- **`available <= 0`** (already at or past the cap): the whole request is
  rejected with `422` — no signed prekey update happens either, since the
  cap check runs before any writes for this request.
- **`available > 0` but less than the batch size**: the incoming
  `oneTimePreKeys` array is **trimmed** to the first `available` entries
  (`otpBatch.slice(0, available)`) — the excess entries at the end of the
  array are silently dropped, not error'd individually. The response's
  `capped: true` tells the client this happened, and
  `uploadedOneTimePreKeys` reports the actual (trimmed) count inserted, so
  the client knows to re-upload the remainder in a later request once some
  keys have been consumed.
- **`available >= batch size`**: the full batch is inserted, `capped: false`.

Concretely: a device with 195 unconsumed one-time keys uploading a batch of
20 gets `available = 5`, so only the first 5 entries of that 20-entry array
are inserted, and the response is
`{ "uploadedSignedPreKey": true, "uploadedOneTimePreKeys": 5, "capped": true }`.
The signed prekey in the same request is still upserted even when the
one-time batch is fully or partially trimmed — capping only affects the
one-time array.

---

*Verified against `apps/backend/src/routes/devices.ts` and
`apps/backend/src/routes/userDevices.ts` as of this writing. If either file
changes, this doc should be updated in the same PR.*