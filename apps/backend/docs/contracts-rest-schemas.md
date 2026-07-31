# REST Request/Response Schema Reference

> **Purpose:** Strict field-level reference for every Zod schema used to validate REST request bodies.
> Generated from the source schemas and middleware call sites.
>
> **Last updated:** 2026-07-29

---

## How to Use This Document

Each schema below is listed with its **fully resolved shape** — field names, Zod types, constraints,
and defaults — as used by the `validate()` middleware or `safeParse()` calls in route handlers.

When writing API usage docs (`api-*.md`), **reference schemas by name** rather than
duplicating field tables:

```markdown
Request body is validated by [`ChallengeSchema`](./contracts-rest-schemas.md#challengeschema).
```

---

## Schema Index

| Schema | Defined In | Used By |
|--------|-----------|---------|
| `ChallengeSchema` | `schemas/auth.schemas.ts` | `POST /auth/challenge` |
| `VerifySchema` | `schemas/auth.schemas.ts` | `POST /auth/verify` |
| `DeviceSchema` | `schemas/auth.schemas.ts` | `POST /devices` (as `RegisterDeviceSchema`), nested in `VerifySchema` |
| `SendMessageSchema` | `schemas/message.schemas.ts` | `POST /messages` |
| `proposeSchema` | `routes/treasury.ts` | `POST /treasury/propose` |
| `voteSchema` | `routes/treasury.ts` | `POST /treasury/proposals/:id/approve`, `POST /treasury/proposals/:id/reject` |
| `RequestSlotSchema` | `routes/uploads.ts` | `POST /uploads` (via `safeParse`) |
| `UploadPreKeysSchema` | `routes/devices.ts` | `POST /devices/:id/prekeys` |
| `EnvelopeSchema` | `schemas/message.schemas.ts` | Nested in `SendMessageSchema.envelopes[]` |
| `IdentityPublicKeySchema` | `lib/keys.ts` | Nested in `DeviceSchema`, `VerifySchema` |
| `PreKeyEntrySchema` | `lib/keys.ts` | Nested in `UploadPreKeysSchema.oneTimePreKeys[]` |
| `SignedPreKeyEntrySchema` | `lib/keys.ts` | Nested in `UploadPreKeysSchema.signedPreKey` |
| `PreKeyPublicKeySchema` | `lib/keys.ts` | Nested in `PreKeyEntrySchema` |
| `SignatureSchema` | `lib/keys.ts` | Nested in `SignedPreKeyEntrySchema` |

---

## `ChallengeSchema`

**Route:** `POST /auth/challenge`

```typescript
z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
})
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `walletAddress` | `string` | ✅ | `min(1)` — cannot be empty |

<details>
<summary>Example</summary>

```json
{
  "walletAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
}
```
</details>

---

## `VerifySchema`

**Route:** `POST /auth/verify`

```typescript
z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
  signature: z.string().min(1, 'signature is required'),
  nonce: z.string().min(1, 'nonce is required'),
  identityPublicKey: IdentityPublicKeySchema,
  device: DeviceSchema.partial().optional(),
}).superRefine(/* cross-field: device.identityPublicKey must match identityPublicKey */)
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `walletAddress` | `string` | ✅ | `min(1)` — cannot be empty |
| `signature` | `string` | ✅ | `min(1)` — cannot be empty (hex or base64-encoded Ed25519 signature) |
| `nonce` | `string` | ✅ | `min(1)` — cannot be empty |
| `identityPublicKey` | `string` | ✅ | Valid base64; must decode to exactly 44 bytes (Ed25519 SPKI DER) |
| `device` | `object?` | ❌ | All sub-fields optional (see [DeviceSchema](#deviceschema)) |
| `device.deviceName` | `string?` | ❌ | `min(1)`, `max(100)` when present |
| `device.platform` | `"web" \| "ios" \| "android"?` | ❌ | Enum when present |
| `device.identityPublicKey` | `string?` | ❌ | If present, **must equal** top-level `identityPublicKey` |
| `device.registrationId` | `number?` | ❌ | Integer, `≥ 0` when present |

<details>
<summary>Example</summary>

```json
{
  "walletAddress": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "signature": "a1b2c3d4e5f6...",
  "nonce": "abc123-def456",
  "identityPublicKey": "MCowBQYDK2VwAyEAnBkR...",
  "device": {
    "deviceName": "My Browser",
    "platform": "web",
    "registrationId": 42
  }
}
```
</details>

---

## `DeviceSchema`

**Routes:** `POST /devices` (aliased as `RegisterDeviceSchema`), nested in `POST /auth/verify`

```typescript
z.object({
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['web', 'ios', 'android']),
  identityPublicKey: IdentityPublicKeySchema,
  registrationId: z.number().int().nonnegative().optional(),
})
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `deviceName` | `string` | ✅ | `min(1)`, `max(100)` |
| `platform` | `"web" \| "ios" \| "android"` | ✅ | Strict enum |
| `identityPublicKey` | `string` | ✅ | Valid base64; must decode to exactly 44 bytes (Ed25519 SPKI DER) |
| `registrationId` | `number?` | ❌ | Integer, `≥ 0` |

<details>
<summary>Example</summary>

```json
{
  "deviceName": "iPhone 15",
  "platform": "ios",
  "identityPublicKey": "MCowBQYDK2VwAyEAnBkR...",
  "registrationId": 123
}
```
</details>

---

## `SendMessageSchema`

**Route:** `POST /messages`

```typescript
z.object({
  conversationId: z.string().uuid('conversationId must be a valid UUID'),
  messageId: z.string().uuid('messageId must be a valid UUID'),
  contentType: z.string().trim().toLowerCase().optional().default('text'),
  ciphertext: z.string().optional(),
  envelopes: z.array(EnvelopeSchema).optional(),
  fileId: z.string().uuid('fileId must be a valid UUID').optional(),
})
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `conversationId` | `string` | ✅ | — | Valid UUID |
| `messageId` | `string` | ✅ | — | Valid UUID (client-generated, idempotency key) |
| `contentType` | `string` | ❌ | `"text"` | Trimmed, lowercased. Not restricted to an enum at the Zod layer (any string is accepted). Common values: `text`, `file`, `image`, `video`, `audio`, `system` |
| `ciphertext` | `string?` | ❌ | — | Encrypted message body |
| `envelopes` | `EnvelopeSchema[]?` | ❌ | — | Per-device encrypted payloads (see [EnvelopeSchema](#envelopeschema)) |
| `fileId` | `string?` | ❌ | — | Valid UUID referencing an uploaded file. Required when `contentType` is `file`/`image`/`video`/`audio` (enforced by `validateMessagePayload`) |

**Note:** Content-type-specific field requirements (fileId, envelopes) are validated at the
`validateMessagePayload` layer rather than in Zod, so both REST and WebSocket paths share the
same rules without duplicating discriminated-union schemas.

<details>
<summary>Example (text message)</summary>

```json
{
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "messageId": "660e8400-e29b-41d4-a716-446655440001",
  "contentType": "text",
  "ciphertext": "base64encryptedpayload...",
  "envelopes": [
    {
      "recipientDeviceId": "770e8400-e29b-41d4-a716-446655440002",
      "ciphertext": "device-specific-ciphertext..."
    }
  ]
}
```
</details>

---

## `EnvelopeSchema`

**Nested in:** `SendMessageSchema.envelopes[]`

```typescript
z.object({
  recipientDeviceId: z.string().uuid('recipientDeviceId must be a valid UUID'),
  ciphertext: z.string().min(1, 'envelope ciphertext is required'),
})
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `recipientDeviceId` | `string` | ✅ | Valid UUID |
| `ciphertext` | `string` | ✅ | `min(1)` — cannot be empty |

---

## `proposeSchema`

**Route:** `POST /treasury/propose`

```typescript
z.object({
  amount: z.number().positive(),
  token: z.string().min(1),
  recipient: z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key'),
  ttl: z.enum(['24h', '72h', '7d']),
  conversationId: z.string().uuid().optional(),
  threshold: z.number().int().min(1).optional(),
})
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `amount` | `number` | ✅ | — | `> 0` (positive) |
| `token` | `string` | ✅ | — | `min(1)` — token contract ID |
| `recipient` | `string` | ✅ | — | Must match `/^G[A-Z2-7]{55}$/` (Stellar public key format) |
| `ttl` | `"24h" \| "72h" \| "7d"` | ✅ | — | Voting window duration (≈17,280 / 51,840 / 120,960 ledgers) |
| `conversationId` | `string?` | ❌ | — | Valid UUID when present |
| `threshold` | `number?` | ❌ | `3` (server default) | Integer, `≥ 1` |

<details>
<summary>Example</summary>

```json
{
  "amount": 100.5,
  "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "recipient": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "ttl": "72h",
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "threshold": 5
}
```
</details>

---

## `voteSchema`

**Routes:** `POST /treasury/proposals/:id/approve`, `POST /treasury/proposals/:id/reject`

```typescript
z.object({
  signature: z.string().optional(),
})
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `signature` | `string?` | ❌ | No min/max length enforced at Zod layer |

<details>
<summary>Example</summary>

```json
{
  "signature": "hex-or-base64-signature..."
}
```
</details>

---

## `RequestSlotSchema`

**Route:** `POST /uploads` (validated via direct `safeParse`, not `validate` middleware)

```typescript
z.object({
  conversationId: z.string().uuid(),
  size: z.number().int().positive().max(100 * 1024 * 1024),
  mimeType: z.string().min(1),
  sha256: z.string().min(1),
  isThumbnail: z.boolean().optional().default(false),
})
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `conversationId` | `string` | ✅ | — | Valid UUID |
| `size` | `number` | ✅ | — | Integer, `> 0`, `≤ 104,857,600` (100 MB) |
| `mimeType` | `string` | ✅ | — | `min(1)`. ⚠ **Post-parse check:** only these types are accepted: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `application/pdf`, `application/octet-stream`. Zod passes any non-empty string; the route returns `415` for unsupported types. |
| `sha256` | `string` | ✅ | — | `min(1)` — hex-encoded SHA-256 hash of the file |
| `isThumbnail` | `boolean` | ❌ | `false` | Whether this upload is a thumbnail variant |

<details>
<summary>Example</summary>

```json
{
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "size": 1048576,
  "mimeType": "image/png",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "isThumbnail": false
}
```
</details>

---

## `UploadPreKeysSchema`

**Route:** `POST /devices/:id/prekeys`

```typescript
z.object({
  signedPreKey: SignedPreKeyEntrySchema,
  oneTimePreKeys: z.array(PreKeyEntrySchema).min(1, 'At least one one-time prekey is required'),
})
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `signedPreKey` | `SignedPreKeyEntrySchema` | ✅ | See below |
| `oneTimePreKeys` | `PreKeyEntrySchema[]` | ✅ | Array with `≥ 1` entries. Server-side cap: 200 stored per device (excess entries are silently trimmed) |

### `signedPreKey` (`SignedPreKeyEntrySchema`)

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `keyId` | `number` | ✅ | Integer, `≥ 0` |
| `publicKey` | `string` | ✅ | Valid base64; must decode to exactly 32 bytes (Ed25519 raw public key) |
| `signature` | `string` | ✅ | Valid base64; must decode to exactly 64 bytes (Ed25519 signature) |

### `oneTimePreKeys[]` (`PreKeyEntrySchema`)

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `keyId` | `number` | ✅ | Integer, `≥ 0` |
| `publicKey` | `string` | ✅ | Valid base64; must decode to exactly 32 bytes (Ed25519 raw public key) |

<details>
<summary>Example</summary>

```json
{
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
  },
  "oneTimePreKeys": [
    { "keyId": 100, "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    { "keyId": 101, "publicKey": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=" }
  ]
}
```
</details>

---

## Shared / Nested Schemas

These schemas are not directly used by routes but are building blocks for the schemas above.

### `IdentityPublicKeySchema`

```typescript
z.string()
  .min(1, 'identityPublicKey is required')
  .superRefine(/* base64 validity + exact 44-byte length (Ed25519 SPKI DER) */)
```

| Field | Type | Constraints |
|-------|------|-------------|
| (value) | `string` | Valid base64, decodes to exactly 44 bytes |

### `PreKeyPublicKeySchema`

```typescript
z.string()
  .min(1, 'publicKey is required')
  .superRefine(/* base64 validity + exact 32-byte length (Ed25519 raw) */)
```

| Field | Type | Constraints |
|-------|------|-------------|
| (value) | `string` | Valid base64, decodes to exactly 32 bytes |

### `SignatureSchema`

```typescript
z.string()
  .min(1, 'signature is required')
  .superRefine(/* base64 validity + exact 64-byte length (Ed25519 sig) */)
```

| Field | Type | Constraints |
|-------|------|-------------|
| (value) | `string` | Valid base64, decodes to exactly 64 bytes |

---

## Error Response Format

All `validate()` middleware failures return:

```json
{
  "error": "Validation failed",
  "issues": [
    { "field": "walletAddress", "message": "walletAddress is required" },
    { "field": "device.platform", "message": "Invalid enum value. Expected 'web' | 'ios' | 'android'" }
  ]
}
```

**Status code:** `400 Bad Request`

Routes using direct `safeParse` (e.g. `POST /uploads`) may use a slightly different
error shape but follow the same `400` convention.

---

## Key Cryptography Constants

| Constant | Value | Usage |
|----------|-------|-------|
| `ED25519_SPKI_BYTES` | 44 | Identity public key byte length (decoded) |
| `ED25519_RAW_KEY_BYTES` | 32 | Raw Ed25519 public key byte length (decoded) |
| `ED25519_SIG_BYTES` | 64 | Ed25519 signature byte length (decoded) |
| `MAX_SIZE_BYTES` | 104,857,600 | Max file upload size (100 MB) |
| `OTP_CAP` | 200 | Max stored one-time prekeys per device |

---

## Schema Validation Flow

```
Client Request
  │
  ▼
express.Router handler
  │
  ├── validate(schema) middleware  ← catches malformed/intentionally-wrong payloads
  │       │
  │       ▼  safeParse(req.body)
  │       │
  │       ├─ success → req.body = parsed result → next()
  │       └─ failure → 400 { error, issues[] }
  │
  ▼
Route handler
  │
  ├── Type narrowing via `as z.infer<typeof Schema>`
  ├── Business logic validation (membership, nonce, signature, mimeType…)
  └── Response
```
