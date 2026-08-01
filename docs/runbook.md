# Operator Runbook (#394)

Operational reference for `apps/backend` — the WebSocket gateway + REST API.
Pair with [`threat-model.md`](./threat-model.md) for what each incident does
and does not expose.

## Scaling gateways

- Each backend instance is horizontally scalable — real-time state (rooms,
  presence, device delivery) is coordinated through Redis, not in-process
  memory. See `@socket.io/redis-adapter` wiring in `apps/backend/src/index.ts`
  (`attachRedisAdapter`).
- Sticky sessions are **not required** at the load balancer for correctness:
  a client can land on any instance because rooms and device→socket routing
  are Redis-backed (`services/deviceDelivery.ts`, `services/presence.ts`,
  `services/roomManager.ts`). Sticky sessions still reduce reconnect churn
  and are recommended for efficiency, not correctness.
- On boot, each instance runs `reconcileBoot` (presence) and
  `rebuildRoomsAfterRestart` (rooms) — safe to add instances at any time;
  new instances self-heal their view of shared state from Redis/Postgres,
  they don't need a peer to copy from.
- Scale-down: send `SIGTERM`. The instance sets `isShuttingDown = true`,
  which is checked in the socket `disconnect` handler so presence is **not**
  wiped for clients who will simply reconnect to another instance — see the
  `reason === 'server shutting down'` short-circuit in `index.ts`.
- Load/soak baselines and thresholds for how many devices one instance can
  hold before backpressure/latency degrade: `scripts/loadtest/` (#385),
  enforced nightly (`.github/workflows/loadtest-nightly.yml`).

## Failure modes

### Redis / message bus down

Symptom: `[socket.io] Redis unavailable` warning at boot, or
`ioredis` error events during runtime (`lib/redis.ts` logs and swallows —
"Graceful degradation: cache misses fall through to DB").

Effect:
- Socket.IO falls back to the **in-process adapter** — each gateway
  instance becomes an isolated single-node system. Clients connected to
  different instances stop receiving each other's messages until Redis
  recovers.
- Presence, device-delivery pub/sub, and per-socket rate limiting
  (`services/rateLimit.ts` returns `{ allowed: true }` when `redis` is
  null) degrade to permissive/no-op rather than failing closed.
- Conversation cache (`lib/redis.ts` `CONV_CACHE_TTL`) misses fall through
  to Postgres — slower, not broken.

Response:
1. Confirm Redis reachability (`redis-cli -u $REDIS_URL ping`).
2. If Redis is down cluster-wide: this is a capacity/availability incident,
   not a data-loss one — messages still persist to Postgres via the
   `fanoutMessage` transaction (`services/fanout.ts`), which has no Redis
   dependency. Delivery to *already-connected* sockets on other instances
   is what's lost until Redis returns; clients resync via `GET /sync` on
   reconnect.
3. Restore Redis, then confirm `[socket.io] Redis adapter attached` in logs
   on each instance (they don't auto-reattach without a restart today —
   restart instances that booted during the outage).
4. Watch `clicked_backpressure_events_total` and `clicked_connected_sockets`
   (per-instance) post-recovery for a thundering-herd reconnect pattern.

### Storage outage (Postgres)

Symptom: `/health` returns `503` with `db: "unreachable"` (`app.ts`).

Effect: message send fails (fanout requires a DB transaction), auth fails
(challenge/verify reads/writes `users`/`devices`), prekey bundle fetch
fails. This is a hard outage for all write paths — sockets stay connected
but functionally idle.

Response:
1. `/health` on each instance is the fastest signal — wire it to your LB
   health check if not already, so unhealthy instances stop receiving new
   connections.
2. Check Postgres directly (connection count, replication lag if using a
   replica, disk space).
3. No special drain procedure needed on the backend side — once Postgres
   recovers, in-flight requests that were retried/queued by clients
   succeed; the backend does not buffer writes in memory that could be
   lost or duplicated.

### Storage outage (S3-compatible object store)

Symptom: file upload/download endpoints fail; `ObjectStore.ensureBucketReachable()`
(`lib/objectStore.ts`) throws.

Effect: text messages are unaffected (they never touch object storage).
File/image/video/audio messages fail at the presign step
(`getPresignedPutUrl`/`getPresignedGetUrl`) before any ciphertext is sent —
no partial/corrupt uploads are possible from an outage, since the client
never gets a URL to upload to.

Response:
1. Confirm reachability of `OBJECT_STORE_ENDPOINT` directly.
2. If using MinIO (`infra/docker-compose.yml`), check the `minio` container
   health and `minio-init` bucket-creation step.
3. No backend restart needed — the S3 client (`lib/objectStore.ts` singleton)
   retries per-request; recovery is transparent once the endpoint returns.

## Key-drain incident response

"Key-drain" here means: a device's one-time prekeys are being consumed
faster than the owner is replenishing them (see
`docs/e2ee-onboarding.md` "prekey-exhausted path"), whether from normal
high-fanout usage or an attacker deliberately exhausting a target's prekeys
to force fallback (signed-prekey-only) sessions.

Detection:
- `clicked_prekey_consumed_total` rate (#393) spiking for a narrow set of
  devices, cross-referenced against `GET /devices` `oneTimePreKeysRemaining`
  (`routes/devices.ts`) trending toward zero.
- Elevated `oneTimePreKey: null` responses from
  `GET /users/:userId/devices/:deviceId/key-bundle` (visible via APM/log
  sampling on that route, not a dedicated metric today).

Response:
1. Identify the affected device(s) from the metric labels / access logs
   (device id, not user content — no ciphertext is involved in this
   incident class).
2. This is not, by itself, a compromise — normal usage exhausts prekeys.
   Escalate only if consumption rate is inconsistent with real message
   volume for that device (check `clicked_messages_persisted_total` /
   fanout size for the same window).
3. If abuse is confirmed (a client hammering `key-bundle` for one victim
   device to drain it faster than the owner's client replenishes):
   rate-limit or block the calling identity at the API layer
   (`express-rate-limit` is already a dependency; the `key-bundle` route
   doesn't have a dedicated limiter today — add one scoped to this route
   if an incident requires it).
4. Victim remediation: the device's client should re-upload a fresh batch
   of one-time prekeys (`POST /devices/:id/prekeys`, capped at 200 per
   `routes/devices.ts`). No server-side reset is needed or possible — the
   server cannot generate prekey private keys on the client's behalf.

## Rotating VAPID / storage credentials

### VAPID (Web Push)

1. Generate a new VAPID keypair (`web-push generate-vapid-keys` or
   equivalent).
2. Update `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` in the
   deployment environment. These are read once at process start
   (`services/pushNotification.ts` — `vapidReady` is set at module load),
   so this requires a rolling restart of all backend instances; there is
   no hot-reload path today.
3. **Compatibility gap:** existing client push subscriptions were created
   against the old public key. Depending on the push provider, subscriptions
   may or may not survive a VAPID key change — treat this as "some clients
   silently stop receiving push until they reopen the app and
   re-subscribe," not as a hard cutover. Coordinate with a client release
   if a hard rotation (e.g., suspected private key compromise) is required.
4. Confirm via `clicked_push_result_total{result="sent"}` continuing to
   increment post-rotation, and watch `result="backoff"`/`"pruned"` for an
   abnormal spike (would indicate subscriptions broke).

### Object storage credentials

1. Provision new `OBJECT_STORE_ACCESS_KEY`/`OBJECT_STORE_SECRET_KEY` at the
   provider (or MinIO) before revoking the old ones.
2. Update env and roll instances. The `ObjectStore` singleton
   (`lib/objectStore.ts`) is constructed once per process, so this also
   requires a restart, not just an env change.
3. Revoke the old credentials only after confirming
   `ensureBucketReachable()` succeeds on all rolled instances (`/health`
   does not currently check object storage — verify via a manual
   upload/download or by watching for a spike in file-route error logs).

## Related documents

- [`threat-model.md`](./threat-model.md) — what the server can/cannot see, residual metadata risk
- [`observability.md`](./observability.md) — metrics reference and dashboard panels used in the detection steps above
- [`e2ee-onboarding.md`](../apps/backend/docs/e2ee-onboarding.md) — prekey/session bootstrap sequence referenced in the key-drain section
- [`signal-integration.md`](./signal-integration.md) — crypto library and forward-secrecy status

Cross-referenced from [`IMPLEMENTATION_DOCS.md`](../IMPLEMENTATION_DOCS.md).
