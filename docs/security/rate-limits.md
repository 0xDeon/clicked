# Rate limits and quotas

Every limit the gateway enforces is declared in
`apps/backend/src/config/rateLimits.ts`. Counters live in Redis
(`apps/backend/src/services/rateLimiter.ts`) so a budget is shared by every
gateway node instead of being multiplied by the node count.

## Buckets

| Bucket                 | Default     | Guards                                                    |
| ---------------------- | ----------- | --------------------------------------------------------- |
| `global_ip`            | 600 / min   | Catch-all per-IP ceiling across every HTTP endpoint       |
| `auth_challenge`       | 10 / min    | `POST /auth/challenge`                                    |
| `auth_verify`          | 5 / min     | `POST /auth/verify`                                       |
| `key_bundle`           | 30 / min    | `GET /users/:userId/devices/:deviceId/key-bundle`         |
| `key_bundle_daily`     | 200 / day   | Quota on the same endpoint — bounds one-time prekey drain |
| `upload_slot`          | 20 / min    | `POST /uploads`                                           |
| `upload_bytes_daily`   | 2 GiB / day | Quota on upload **volume**, charged in bytes              |
| `file_download`        | 120 / min   | `GET /files/:fileId`                                      |
| `push_subscribe`       | 10 / min    | `POST /push/subscriptions`                                |
| `socket_default`       | 10 / sec    | Any socket event without its own bucket                   |
| `socket_send_message`  | 30 / 10 sec | `send_message`, `send_file_message`                       |
| `socket_typing`        | 20 / 5 sec  | `typing_start`, `typing_stop`                             |
| `socket_ask_assistant` | 5 / min     | `ask_assistant`                                           |

## Configuring per environment

Override any bucket with `RATE_LIMIT_<BUCKET_NAME>=<limit>[/<windowSeconds>]`:

```bash
RATE_LIMIT_KEY_BUNDLE=60/60      # 60 fetches per minute
RATE_LIMIT_AUTH_VERIFY=3         # 3 per minute (window unchanged)
RATE_LIMIT_UPLOAD_BYTES_DAILY=10737418240
```

A malformed value is ignored with a warning and the default stands — a typo
must never silently remove a limit. `RATE_LIMIT_DISABLED=true` switches
everything off for local debugging and load tests; never set it in production.
The historical `SOCKET_RATE_LIMIT_PER_SEC` still works as a `socket_default`
override so existing deployments keep behaving as configured.

## What a limit is charged to

- **Before authentication** (`/auth/*`, `global_ip`): the client IP.
- **After authentication**: the user id. An account with many devices behind
  one NAT must not exhaust a shared IP budget, and an attacker must not be able
  to dodge a per-account quota by rotating source addresses.
- **Socket events**: the device id from the verified token. A socket id is
  minted fresh on every reconnect, so charging it would let a throttled client
  reset its budget just by cycling the connection. The device id survives
  reconnects and cannot be spoofed from an event payload.
- **`ask_assistant`**: the user id, because the cost being protected is the
  downstream AI call, which one account can run up from any of its devices.

## Two buckets on one endpoint

`key_bundle` and `upload_*` are each guarded by a short burst window _and_ a
long-window quota. The burst window stops a scraper; the daily quota stops the
slow drip that never trips it. On the key-bundle endpoint that quota is the one
that matters: draining a device's one-time prekeys silently downgrades every
new session with it from 4-DH to 3-DH.

The upload quota is charged in bytes rather than requests, because a per-minute
slot limit says nothing about a caller requesting twenty hundred-megabyte slots
an hour — which is the shape that actually fills object storage.

## Responses

A blocked HTTP request gets `429` with `Retry-After` and the standard
`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers:

```json
{ "error": "Too many requests", "bucket": "key_bundle", "retryAfterSeconds": 37 }
```

A blocked socket event gets an `error` event naming the event, its limit and
the retry delay, so a client can back off precisely instead of guessing:

```json
{
  "event": "rate_limited",
  "message": "Rate limit exceeded",
  "limitedEvent": "send_message",
  "limit": 30,
  "retryAfterSeconds": 4
}
```

Three violations on one socket still disconnect it, unchanged.

## Windows and degradation

Counters use fixed windows keyed by `floor(now / windowSeconds)`. A sliding log
would be more precise at the boundary, but a fixed window costs one `INCRBY`
and one `EXPIRE` per check, and the worst case (2x the limit across a boundary)
is acceptable for abuse control. Because the window index is part of the key,
expiry is self-correcting and no sweeper is needed.

If Redis is unreachable the check falls back to a **per-process** counter
rather than failing open. A cross-node limit degrades to a per-node limit —
still bounded — instead of taking the whole API down with Redis. This matches
how the rest of the gateway treats a Redis outage.

## Operations

`resetRateLimitBucket(bucket)` clears every counter in a bucket across all
windows and subjects, for unblocking after a bad limit change. It scans rather
than using `KEYS`, so it will not stall a busy Redis.
