# MLS key packages

Group messaging uses MLS (RFC 9420). Before a device can be added to a group it
must have published at least one **KeyPackage** — a signed bundle containing its
credential, its HPKE init public key, and the cipher suite it supports. Any
existing group member can then build an `Add` proposal for that device without
the device being online.

This document describes the backend surface for publishing and claiming those
key packages (issue #365).

## What the server stores

Table: `mls_key_packages`

| Column         | Type        | Notes                                                     |
| -------------- | ----------- | --------------------------------------------------------- |
| `id`           | `uuid`      | Primary key.                                              |
| `device_id`    | `uuid`      | FK → `devices.id`, `ON DELETE CASCADE`.                   |
| `cipher_suite` | `integer`   | IANA MLS cipher suite id the package was generated for.   |
| `key_package`  | `text`      | Base64 of the TLS-serialised KeyPackage. Public material. |
| `package_hash` | `text`      | SHA-256 (hex) of `key_package` — dedupe key.              |
| `expires_at`   | `timestamp` | Optional. Nullable means "does not expire".               |
| `consumed`     | `boolean`   | Flipped when the package is handed out. Never deleted.    |
| `consumed_at`  | `timestamp` | When the package was claimed.                             |
| `created_at`   | `timestamp` | Publication time; claims are FIFO on this column.         |

Indexes:

- `mls_key_packages_device_hash_idx` — unique on `(device_id, package_hash)`.
  Makes re-uploading a package a no-op instead of a duplicate row. The hash is
  the conflict target rather than `key_package` itself because a KeyPackage can
  be up to 4 KiB, which exceeds the btree index row limit.
- `mls_key_packages_available_idx` — partial index on
  `(device_id, cipher_suite, created_at) WHERE consumed = false`, so claiming
  the next package is a single index lookup.

### Only public material is stored

A KeyPackage contains no secrets. The HPKE init private key and the signature
private key that correspond to it stay on the device and are never uploaded. A
compromise of `mls_key_packages` reveals which devices exist and which cipher
suites they support — the same information `GET /devices` already exposes to the
owner — and nothing that lets an attacker read group messages.

### Single-use, and why it is enforced

MLS treats a KeyPackage as single-use. If the same package were consumed by two
different `Add` proposals, the joining device would derive its initial secrets
from the same init key in both groups, so compromising one group's state would
compromise the other's. The fetch endpoint therefore claims a package inside a
transaction using `SELECT ... FOR UPDATE SKIP LOCKED` and flips `consumed`
before returning: two members adding the same device at the same moment receive
two different packages, and an exhausted device returns `409` rather than a
package that has already been handed out.

`consumed` is a flag rather than a delete so the history of which packages were
issued stays auditable — the same choice `device_prekeys` makes for one-time
prekeys.

## Endpoints

Both endpoints require `Authorization: Bearer <jwt>`.

### POST /devices/:id/mls-key-packages

Publishes a batch of key packages for a device. `:id` must be a device owned by
the authenticated user.

Request:

```json
{
  "cipherSuite": 1,
  "keyPackages": [
    { "keyPackage": "base64-tls-serialised-keypackage" },
    { "keyPackage": "base64-...", "expiresAt": "2026-12-31T00:00:00.000Z" }
  ]
}
```

- `cipherSuite` — positive integer, applied to every package in the batch.
  Publish separate batches to support several suites.
- `keyPackages` — 1 to 100 entries.
- `keyPackage` — base64, decoding to 32–4096 bytes (validated by
  `src/lib/keys.ts`).
- `expiresAt` — optional ISO-8601 timestamp, must be in the future.

Response `200`:

```json
{ "uploaded": 2, "duplicates": 0, "capped": false, "remaining": 2 }
```

- `uploaded` — rows actually inserted.
- `duplicates` — packages the device had already published (dropped by the
  unique index, or collapsed within the batch itself).
- `capped` — true when the batch was trimmed to fit the per-device cap.
- `remaining` — unconsumed, unexpired packages the device now holds.

Uploads are idempotent: retrying a request that timed out mid-flight re-sends
the same packages and reports them as `duplicates` instead of inflating the
inventory.

Errors:

| Status | Body                                                               | When                                                  |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| `400`  | `{ "error": "Validation failed", "issues": [...] }`                | Malformed base64, wrong size, empty or oversize batch |
| `400`  | `{ "error": "expiresAt must be in the future" }`                   | A package in the batch is already expired             |
| `403`  | `{ "error": "Only the device owner may upload MLS key packages" }` | Caller does not own `:id`                             |
| `403`  | `{ "error": "Device is revoked" }`                                 | Device has a `revokedAt`                              |
| `404`  | `{ "error": "Device not found" }`                                  | No such device                                        |
| `422`  | `{ "error": "MLS key package cap of 100 reached..." }`             | Device already holds 100 unconsumed packages          |

### GET /users/:userId/devices/:deviceId/mls-key-package

Claims exactly one key package so the caller can put it in an `Add` proposal.
`:deviceId` must belong to `:userId` and must not be revoked, otherwise the
route returns `404` — a caller cannot probe for devices without already knowing
who owns them.

Optional query parameter:

- `cipherSuite` — positive integer. Restricts the claim to packages published
  for that suite. A group can only add a device whose package matches the
  group's cipher suite, so callers adding to an existing group should always
  pass it.

Response `200`:

```json
{
  "deviceId": "uuid",
  "cipherSuite": 1,
  "keyPackage": "base64-tls-serialised-keypackage",
  "expiresAt": null,
  "remaining": 41
}
```

Response `409` when the device has no packages left:

```json
{ "error": "No MLS key packages available for this device", "remaining": 0 }
```

A `409` is not a permanent failure. The target device replenishes when it next
comes online (see below); the caller should retry then, or add the remaining
devices and re-run the `Add` for this one later.

## Replenishment

Every claim recounts the device's available stock. When that count drops to
`10` or fewer, the server emits:

```text
event: mls_key_packages_low
payload: { deviceId, remaining, threshold: 10, cap: 100 }
```

to two rooms:

- `room:device:<deviceId>` — the device itself, so it uploads a fresh batch
  immediately if it is connected.
- `room:user:<userId>` — the owner's other devices, so the prompt can be
  surfaced even when the low device is offline.

This mirrors the one-time prekey inventory: a device that reaches zero cannot be
added to any new group until it comes back online, so clients should treat the
signal as a cue to top back up to the cap rather than waiting for exhaustion.

Clients that miss the signal can also read the current count from the
`remaining` field of their own upload responses.

## Client sequence

```text
Device A (joining)              Backend                    Device B (adding A)
  |                                |                              |
  |-- POST /devices/:id            |                              |
  |   /mls-key-packages ---------->|                              |
  |<- { uploaded, remaining } -----|                              |
  |                                |                              |
  |                                |<- GET /users/:u/devices/:d --|
  |                                |   /mls-key-package?cipherSuite=1
  |                                |-- claim + mark consumed ---->|
  |                                |   { keyPackage } ----------->|
  |                                |                              |
  |                                |            builds Add proposal + Commit
  |                                |            sends Welcome to device A
  |<- mls_key_packages_low --------|                              |
  |   (when stock <= 10)           |                              |
  |-- POST /devices/:id            |                              |
  |   /mls-key-packages ---------->|                              |
```

## Implementation references

- schema: `apps/backend/src/db/schema.ts` (`mlsKeyPackages`)
- migration: `apps/backend/drizzle/0001_mls_key_packages.sql`
- claim + replenishment: `apps/backend/src/services/mlsKeyPackages.ts`
- upload endpoint: `apps/backend/src/routes/devices.ts`
- fetch endpoint: `apps/backend/src/routes/users.ts`
- key material validation: `apps/backend/src/lib/keys.ts`
- tests: `apps/backend/src/__tests__/mlsKeyPackages.test.ts`
