# Files & uploads API

This document describes every route exposed by `apps/backend/src/routes/uploads.ts` and `apps/backend/src/routes/files.ts`:

- `POST /uploads` — request a presigned upload slot
- `POST /uploads/:fileId/confirm` — mark a file as ready after upload
- `GET /files/:fileId` — obtain a presigned download URL

All three routes require authentication (see `POST /auth/verify` in [`api-auth.md`](api-auth.md)). The `requireAuth` middleware is applied at the router level.

---

## Size & MIME constraints

| Constraint | Value | Source |
|---|---|---|
| Max file size | **100 MB** (`100 * 1024 * 1024` bytes) | `routes/uploads.ts:14` |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `routes/uploads.ts:16-21` |
| | `video/mp4`, `video/webm` | |
| | `audio/mpeg`, `audio/ogg`, `audio/wav` | |
| | `application/pdf`, `application/octet-stream` | |

Any MIME type outside this set is rejected with HTTP `415` during slot request.

---

## `POST /uploads`

Requests a presigned upload slot for a file. The caller must be a member of the target conversation.

**Auth:** Required (JWT from `POST /auth/verify`).

### Request body

```json
{
  "conversationId": "550e8400-e29b-41d4-a716-446655440000",
  "size": 4194304,
  "mimeType": "image/png",
  "sha256": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
  "isThumbnail": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `conversationId` | `string` (uuid) | yes | Target conversation UUID. |
| `size` | `number` (int) | yes | File size in bytes. Must be 1 ≤ size ≤ 100,000,000. |
| `mimeType` | `string` | yes | Must be in the allowed MIME types set (see above). |
| `sha256` | `string` | yes | Hex-encoded SHA-256 hash of the file content. |
| `isThumbnail` | `boolean` | no | Whether this is a thumbnail of a larger file. Defaults to `false`. |

### Responses

#### `201` — Slot created

```json
{
  "fileId": "660e8400-e29b-41d4-a716-446655440001",
  "uploadUrl": "https://storage.example.com/uploads/conv-uuid/a1b2...c3d4?X-Expires=..."
}
```

| Field | Type | Description |
|---|---|---|
| `fileId` | `string` | UUID of the newly created file row (status: `pending`). |
| `uploadUrl` | `string` | Presigned PUT URL. Valid for 15 minutes (production) or a fake URL (dev/test). |

The client must perform a `PUT` request to `uploadUrl` with the file bytes as the body and the declared `mimeType` as `Content-Type`. **There is no server-side storage verification** — see confirm step below.

#### `400` — Validation error

Returned when the request body fails schema validation (e.g., missing field, non-uuid `conversationId`, size exceeds max, etc.).

```json
{
  "error": "Invalid request",
  "details": [
    {
      "code": "too_big",
      "path": ["size"],
      "message": "Number must be less than or equal to 100000000"
    }
  ]
}
```

#### `403` — Not a conversation member

```json
{ "error": "Not a member of this conversation" }
```

#### `415` — Unsupported media type

```json
{ "error": "Unsupported media type", "mimeType": "image/tiff" }
```

---

## `POST /uploads/:fileId/confirm`

Marks a `pending` file as `ready`. The client should call this after successfully uploading the bytes to the presigned PUT URL.

**Auth:** Required (JWT from `POST /auth/verify`). Only the original uploader may confirm.

### Path parameter

| Parameter | Description |
|---|---|
| `fileId` | UUID of the file row returned by `POST /uploads`. |

### Responses

#### `200` — Confirmed

```json
{
  "fileId": "660e8400-e29b-41d4-a716-446655440001",
  "status": "ready"
}
```

The file is now eligible to be referenced in a message.

#### `400` — Missing fileId

```json
{ "error": "fileId is required" }
```

#### `403` — Not authorized

Returned when the authenticated user is not the original uploader.

```json
{ "error": "Not authorized to confirm this upload" }
```

#### `404` — File not found

```json
{ "error": "File not found" }
```

#### `409` — Already ready

```json
{ "error": "File is already ready" }
```

#### `409` — Deleted

```json
{ "error": "File has been deleted" }
```

### What confirm does and does not verify

**Does:**
- Asserts the requesting user is the original uploader (`uploaderId` check).
- Asserts the file exists and is in a confirmable state (`pending`).
- Transitions status from `pending` → `ready`.

**Does NOT:**
- Verify the file bytes were actually uploaded to storage.
- Check the uploaded content's SHA-256 hash against the value declared in the slot request.
- Re-check file size or MIME type against the stored metadata.
- Perform any integrity check (hash comparison, storage HEAD request, etc.).

The confirm handler is a pure database state transition: it trusts that the client successfully performed the PUT and does not reach out to the object store to verify.

---

## `GET /files/:fileId`

Issues a short-lived presigned GET URL so the client can download the file (ciphertext) and decrypt it locally.

**Auth:** Required (JWT from `POST /auth/verify`). The caller must be a member of the conversation where the file was shared.

### Path parameter

| Parameter | Description |
|---|---|
| `fileId` | UUID of the file row. |

### Responses

#### `200` — URL issued

```json
{
  "url": "https://storage.example.com/uploads/conv-uuid/a1b2...c3d4?X-Expires=..."
}
```

The presigned URL is valid for **5 minutes** (300 seconds). The client should start the download immediately. In dev/test environments the URL is a structurally-plausible fake (see `storage.ts:15-19`).

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Presigned GET URL. |

#### `400` — Missing fileId

```json
{ "error": "File id is required" }
```

#### `403` — Not authorized

Returned when the authenticated user is not a member of the conversation that contains the referencing message.

```json
{ "error": "Not authorized to access this file" }
```

#### `404` — File not found

Returned when the file row does not exist, has been soft-deleted (`deletedAt` is set), or is not referenced by any message.

```json
{ "error": "File not found" }
```

Also returned (same shape) when the file exists but no message references it:

```json
{ "error": "File not referenced by any message" }
```

#### `500` — Download URL generation failed

```json
{ "error": "Failed to generate download URL" }
```

### Access control flow

1. File existence and `deletedAt` are checked first.
2. The message referencing the file is looked up (via `messages.fileId`).
3. Conversation membership is verified against `message.conversationId`.
4. A presigned GET URL is generated for the file's `storageKey`.

---

## File lifecycle

```
                  PUT /uploads       POST /uploads/:id/confirm
                     (client ──→ storage)       (client ──→ backend)
                         │                              │
                         ▼                              ▼
  [slot allocated] ──→  pending ──────────────────→   ready
                                                      │
                                                  [file message references it]
                                                      │
                                                      ▼
                                                   deleted
                                               (soft, via retraction)
                                                      │
                                                      ▼
                                               hardDeletedAt
                                              (background cleanup)
```

- `pending` — slot allocated, not yet confirmed.
- `ready` — confirm handler called; file is eligible for message attachment.
- `deleted` — soft-deleted (`deletedAt` set) when referencing messages are retracted.
- Files with `deletedAt` set are excluded from `GET /files/:fileId` (returns `404`).
- `hardDeletedAt` is set by a background cleanup job after no live references remain.

---

## Implementation references

- Upload slot + confirm routes: `apps/backend/src/routes/uploads.ts`
- Download route: `apps/backend/src/routes/files.ts`
- Presigned URL generation (S3/MinIO / dev fallback): `apps/backend/src/lib/storage.ts`
- Object store abstraction: `apps/backend/src/lib/objectStore.ts`
- Database schema (files table): `apps/backend/src/db/schema.ts` (lines 86–105)
