# Push subscription API

This document describes the Web Push subscription endpoints used by clients to
register for push notifications and the VAPID configuration those subscriptions
depend on.

The backend uses the [web-push](https://github.com/web-push-libs/web-push) library
to deliver push notifications via the browser/OS push service. Subscriptions are
persisted in the `push_subscriptions` table and scoped to the authenticated device.

## Current backend surface

- `POST /push/subscriptions` — subscribe (upsert)
- `DELETE /push/subscriptions` — unsubscribe

## Authentication

All push endpoints require a valid JWT obtained from `POST /auth/verify`.

```text
Authorization: Bearer <jwt>
```

The authenticated `deviceId` from the JWT is used to scope subscriptions: a
subscription can only be created or deleted for the caller's own device.

## Data model

Table `push_subscriptions` (defined in `apps/backend/src/db/schema.ts:334`):

```json
{
  "id": "uuid",
  "deviceId": "uuid",
  "endpoint": "text (unique)",
  "p256dh": "text",
  "auth": "text",
  "lastUsedAt": "timestamp | null",
  "disabledAt": "timestamp | null",
  "createdAt": "timestamp"
}
```

- `deviceId` references the `devices` table (cascade delete).
- `endpoint` is the unique push endpoint URL assigned by the browser/OS push
  service.
- `p256dh` and `auth` are the encryption keys the push service returns during
  subscription.
- `disabledAt` is set when a subscription returns `410 Gone` or `404 Not Found`
  (pruned) or after a transient failure (backoff window).
- `lastUsedAt` is bumped each time a push is successfully sent.

## Endpoints

### 1) Subscribe

Register a new push subscription or re-activate an existing one.

```text
POST /push/subscriptions
```

Request JSON:

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "base64-encoded-raw-public-key",
    "auth": "base64-encoded-raw-auth-secret"
  }
}
```

Success response:

```json
{ "success": true }
```

Status: `200`

The endpoint uses `ON CONFLICT ... DO UPDATE` on the `endpoint` column — if the
same endpoint URL already exists in the database (from a previous subscription
on any device), its `p256dh`, `auth`, and `deviceId` are updated, `disabledAt`
is cleared, and `lastUsedAt` is refreshed.

Possible error responses:

```json
{ "error": "Missing endpoint or keys" }
```

Status: `400` — `endpoint`, `keys`, `keys.p256dh`, or `keys.auth` is missing
from the request body.

```json
{ "error": "Failed to register subscription" }
```

Status: `500` — database write failed.

### 2) Unsubscribe

Remove a push subscription for the authenticated device.

```text
DELETE /push/subscriptions
```

Request JSON:

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/..."
}
```

Success response:

Status: `204` — no body. The row is deleted only if the `endpoint` matches a
subscription owned by the authenticated `deviceId`.

Possible error responses:

```json
{ "error": "Endpoint is required" }
```

Status: `400` — `endpoint` is missing from the request body.

```json
{ "error": "Failed to delete subscription" }
```

Status: `500` — database delete failed.

## VAPID key configuration

Web Push requires VAPID keys to authenticate the application server with the
push service. The backend reads these from environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAPID_PUBLIC_KEY` | no (push disabled if absent) | — | VAPID application server public key |
| `VAPID_PRIVATE_KEY` | no (push disabled if absent) | — | VAPID application server private key |
| `VAPID_SUBJECT` | no | `mailto:admin@clicked.app` | Contact URI for the push service |

These are declared as optional in the environment schema
(`apps/backend/src/config.ts:18-20`). When both `VAPID_PUBLIC_KEY` and
`VAPID_PRIVATE_KEY` are set, the service initialises web-push and push
notifications are enabled. Otherwise `dispatchOfflinePush` is a no-op.

### How the client obtains the VAPID public key

There is currently **no backend endpoint** that exposes `VAPID_PUBLIC_KEY` to
clients. The client must obtain it through one of these out-of-band channels:

- **Build-time config**: the key is baked into the client bundle at compile time
  (e.g. via an environment variable in the client build).
- **Static well-known URL**: the key could be served from a static path
  (e.g. `/.well-known/vapid-public-key.txt`).

Until a dedicated config endpoint is added, clients should retrieve the VAPID
public key from the deployment configuration.

### What the client does with the key

When subscribing to push on the client side, the VAPID public key is passed as
the `applicationServerKey` option to the Push API's
`registration.pushManager.subscribe()` call. The resulting subscription object
contains the `endpoint`, `p256dh`, and `auth` fields that the client then sends
to `POST /push/subscriptions`.

## Internal functions

The following functions in `apps/backend/src/routes/push.ts` are not exposed as
HTTP endpoints but are used internally by the push delivery pipeline:

- **`touchSubscription(endpoint)`** — updates `lastUsedAt` for an active
  subscription (used before sending a push).
- **`disableSubscription(endpoint)`** — sets `disabledAt` for a subscription
  that returned a non-recoverable error.

These are consumed by the push notification service at
`apps/backend/src/services/pushNotification.ts`, which handles:

- Coalescing burst messages into a single push per device per conversation
  (2-second window, #239).
- Per-device rate limiting (30-second window, #239).
- Dead subscription pruning on `410 Gone` / `404 Not Found` (#237).
- Transient failure backoff (5-minute `disabledAt`, #237).

## Ordering and guarantees

1. The client must authenticate via `POST /auth/verify` before calling any push
   endpoint.
2. The client should subscribe to push **after** receiving the JWT and must send
   the subscription object returned by the browser Push API.
3. A client that already has a stored subscription should call
   `POST /push/subscriptions` again on reconnect — the upsert semantics make
   this safe and idempotent.
4. When a user logs out or explicitly disables notifications, the client should
   call `DELETE /push/subscriptions` with the stored endpoint so the server does
   not continue sending pushes to a stale subscription.
5. If the push service returns `410 Gone`, the backend prunes the subscription
   automatically on the next send attempt. The client does not need to
   unsubscribe proactively, but doing so is more efficient.

## Implementation references

- Push route handlers: `apps/backend/src/routes/push.ts`
- Push notification delivery: `apps/backend/src/services/pushNotification.ts`
- Push subscription schema: `apps/backend/src/db/schema.ts:334`
- VAPID env config: `apps/backend/src/config.ts:18-20`
- Push subscription tests: `apps/backend/src/__tests__/push.test.ts`
- Push notification service tests: `apps/backend/src/__tests__/pushNotification.test.ts`
