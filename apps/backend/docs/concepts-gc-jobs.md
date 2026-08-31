# Background GC Jobs Reference

This document is the operational reference for every scheduled cleanup pass the backend
runs: what each one deletes, how often, how long it waits before deleting it, and how to
retune that via environment variables. For the broader file-lifecycle and push-hygiene
picture these jobs sit inside, see
[`concepts-storage-push-jobs.md`](./concepts-storage-push-jobs.md).

## Contents

- [Summary table](#summary-table)
- [Device / key GC — `services/deviceGc.ts`](#device--key-gc--servicesdevicegcts)
- [Envelope GC — `services/envelopeGc.ts`](#envelope-gc--servicesenvelopegcts)
- [File cleanup — `services/fileCleanup.ts`](#file-cleanup--servicesfilecleanupts)
- [Push-subscription backoff re-enable](#push-subscription-backoff-re-enable)
- [Idempotency and retry-safety, in general](#idempotency-and-retry-safety-in-general)
- [Multi-node deployment implications](#multi-node-deployment-implications)

## Summary table

| Job | Interval (default) | Interval env var | What it removes | Retention window (default) | Retention env var(s) |
|---|---|---|---|---|---|
| Prekey GC | 1 hour | `DEVICE_GC_INTERVAL_MS` | Consumed or unclaimed one-time prekeys (`device_prekeys`, `key_type = 'one_time'`) | 30d consumed / 90d unconsumed | `PREKEY_CONSUMED_RETENTION_DAYS`, `PREKEY_UNCONSUMED_MAX_AGE_DAYS` |
| MLS key package GC | 1 hour | `DEVICE_GC_INTERVAL_MS` | Consumed or unclaimed MLS `KeyPackage`s (`mls_key_packages`) | 30d consumed / 90d unconsumed | `PREKEY_CONSUMED_RETENTION_DAYS`, `PREKEY_UNCONSUMED_MAX_AGE_DAYS` |
| Device stale-flag | 1 hour | `DEVICE_GC_INTERVAL_MS` | Nothing — flags (`stale_flagged_at`) devices revoked past the window | 180d since revocation | `DEVICE_STALE_AFTER_DAYS` |
| Envelope GC | 30 minutes | `ENVELOPE_GC_INTERVAL_MS` | `message_envelopes` rows (per-recipient-device delivery units) | 7d after delivery / 30d max age regardless | `ENVELOPE_DELIVERED_RETENTION_DAYS`, `ENVELOPE_MAX_AGE_DAYS` |
| File hard-delete | 5 minutes | `FILE_GC_INTERVAL_MS` | S3 objects (+ `files` row marked `hard_deleted_at`) for soft-deleted, fully-unreferenced files | 0ms grace by default, then immediate | `FILE_HARD_DELETE_GRACE_MS` |
| Pending-upload GC | 5 minutes (same tick as file hard-delete) | `FILE_GC_INTERVAL_MS` | S3 objects + `files` rows for uploads never confirmed | 24 hours since creation | `PENDING_UPLOAD_TTL_MS` |
| Push-subscription backoff re-enable | 5 minutes (same tick as file hard-delete) | `FILE_GC_INTERVAL_MS` | Nothing — clears `disabled_at` on `push_subscriptions` whose backoff has expired | n/a — driven by the 5-minute backoff set at send time, not a configurable window | none |

All six passes are started once at process boot, in [`index.ts`](../src/index.ts), and
run on a plain `setInterval` for the lifetime of the process (`.unref()`'d so they never
keep the process alive on their own).

---

## Device / key GC — `services/deviceGc.ts`

Three independent passes share one hourly timer (`startDeviceGcJob`):

### 1. One-time prekey pruning (`runPrekeyGcPass`)

- **Removes**: rows in `device_prekeys` where `key_type = 'one_time'` and either
  - `consumed = true` and `created_at` is older than `PREKEY_CONSUMED_RETENTION_DAYS`
    (default **30 days**) — the recipient already claimed it, kept only for audit, or
  - `consumed = false` and `created_at` is older than `PREKEY_UNCONSUMED_MAX_AGE_DAYS`
    (default **90 days**) — nobody claimed it in time.
- Signed prekeys are never touched by this pass — a device has exactly one live signed
  prekey and it's replaced in place on upload, not garbage-collected.

### 2. MLS KeyPackage pruning (`runMlsKeyPackageGcPass`)

- Same two-tier policy (consumed vs. unconsumed, same two env vars) applied to
  `mls_key_packages` instead of `device_prekeys`. Kept as a separate pass because the two
  tables are unrelated, but they're tuned by the same knobs since they represent the same
  "unclaimed one-time key material" concept for two different protocols.

### 3. Stale-device flagging (`runDeviceStaleFlagPass`)

- **Flags, never deletes.** Sets `devices.stale_flagged_at` on rows where
  `revoked_at IS NOT NULL`, `revoked_at` is older than `DEVICE_STALE_AFTER_DAYS`
  (default **180 days**), and `stale_flagged_at IS NULL`.
- Revocation history is preserved indefinitely — this pass only marks a device eligible
  for whatever downstream archival/audit process consumes the flag; it does not delete
  the `devices` row or any of its history.

**Env vars**: `DEVICE_GC_INTERVAL_MS` (tick interval, default 1h),
`PREKEY_CONSUMED_RETENTION_DAYS` (default 30), `PREKEY_UNCONSUMED_MAX_AGE_DAYS`
(default 90), `DEVICE_STALE_AFTER_DAYS` (default 180). All four are read via a shared
`envDays()`/interval helper that falls back to the default on a missing, non-numeric, or
non-positive value — a malformed env var degrades to "use the default", not a crash.

---

## Envelope GC — `services/envelopeGc.ts`

`message_envelopes` holds one row per **(message, recipient device)** — the actual
delivery unit. It is the only thing that keeps a delivered message's audit trail (the
delivered/read timestamps) around after the fact, and it grows with every message times
every recipient device, so it needs the tightest retention of any table in the system.

`runEnvelopeGcPass` deletes a row when either is true:

- **Delivered and aged out**: `delivered_at IS NOT NULL` and `delivered_at` is older
  than `ENVELOPE_DELIVERED_RETENTION_DAYS` (default **7 days**) — the common case, the
  recipient device picked it up.
- **Past the max-age ceiling regardless of delivery state**: `created_at` is older than
  `ENVELOPE_MAX_AGE_DAYS` (default **30 days**) — a device that never comes back to
  collect its envelope does not get to pin storage forever.

**Schedule**: every 30 minutes by default (`ENVELOPE_GC_INTERVAL_MS`).

**Env vars**: `ENVELOPE_GC_INTERVAL_MS`, `ENVELOPE_DELIVERED_RETENTION_DAYS`,
`ENVELOPE_MAX_AGE_DAYS`.

---

## File cleanup — `services/fileCleanup.ts`

Implements the soft-delete → hard-delete lifecycle from issue #231. `softDeleteFile()`
sets `files.deleted_at` synchronously when a message referencing it is retracted (it is
not part of the scheduled job — it's called inline from the message-delete path). The
scheduled job (`startFileCleanupJob`, tick interval `FILE_GC_INTERVAL_MS`, default
**5 minutes**) then does three things per tick, in order:

### 1. Hard-delete pass (`runHardDeletePass`, first half)

Candidates: `files` rows where `deleted_at IS NOT NULL`, `hard_deleted_at IS NULL`, and
`deleted_at` is older than `FILE_HARD_DELETE_GRACE_MS` (default **0** — no grace period,
eligible as soon as soft-deleted).

For each candidate the job:

1. **Re-checks the reference count** (see below) — if any live message still points at
   the file, it's skipped this tick and picked up again on a later one once that last
   reference clears.
2. Deletes the S3 object via `getObjectStore().deleteObject(storageKey)`.
3. Only after that delete succeeds, sets `hard_deleted_at = now()`.

A failure at step 2 or 3 is caught, logged, and the file is simply left in its current
(soft-deleted, not-yet-hard-deleted) state for the next tick to retry — no exception
propagates out of the loop, so one bad object doesn't stop the rest of the batch.

### 2. Pending-upload GC (`runHardDeletePass`, second half)

Candidates: `files` rows with `status = 'pending'` and `created_at` older than
`PENDING_UPLOAD_TTL_MS` (default **24 hours**) — an upload slot was requested but the
client never confirmed it. The object is deleted from S3 and the `files` row is deleted
outright (there's no soft-delete step for a pending upload; nothing ever referenced it).

### 3. Push-subscription backoff re-enable

See [below](#push-subscription-backoff-re-enable) — runs as the last step of the same
tick, after the hard-delete pass, in `startFileCleanupJob`'s interval callback.

### Reference-counting check

Before either the initial candidate query or the hard delete itself, the job protects
against deleting a file another live message still points at:

```sql
SELECT 1 FROM messages
WHERE file_id = <fileId>
  AND deleted_at IS NULL
LIMIT 1
```

If this returns a row, the file is skipped for this tick. This matters because a file
can be attached to more than one message (e.g. forwarded), so retracting *one* message
that references a file must not delete the underlying object while another,
non-retracted message still needs it. `softDeleteFile()` itself runs the same
`NOT EXISTS (...)` check inline (as part of its `UPDATE ... WHERE`) before it will even
set `deleted_at`, so a file only becomes hard-delete-eligible once every referencing
message has been retracted.

**Env vars**: `FILE_GC_INTERVAL_MS` (default 5min), `FILE_HARD_DELETE_GRACE_MS` (default
0), `PENDING_UPLOAD_TTL_MS` (default 24h).

---

## Push-subscription backoff re-enable

Not a standalone timer — it's called (`reenableExpiredBackoffs()`, defined in
`services/pushNotification.ts`) as the second step of every file-cleanup tick, so it
inherits `FILE_GC_INTERVAL_MS` as its effective schedule (default every 5 minutes).

**What it removes**: nothing is deleted. It's a single `UPDATE`:

```sql
UPDATE push_subscriptions
SET disabled_at = NULL
WHERE disabled_at IS NOT NULL AND disabled_at <= NOW()
```

**Where the backoff comes from**: a transient push-send failure (any error other than a
404/410 "gone" response, which prunes the subscription immediately instead) sets
`disabled_at = now() + 5 minutes` in `sendWebPush()`. This pass is what clears that flag
once the 5-minute window has elapsed, making the subscription eligible for delivery
again. There is no separate env var for the backoff duration itself — it's a fixed
5-minute constant at the call site — only the re-enable pass's cadence is configurable,
and only indirectly via `FILE_GC_INTERVAL_MS`.

---

## Idempotency and retry-safety, in general

Every pass above is safe to crash mid-run and simply pick back up on the next tick,
by construction:

- **Prekey / MLS key package GC**: a plain `DELETE ... WHERE <cutoff>` is naturally
  idempotent — a row either still matches the cutoff (gets deleted again, a no-op if it
  was already gone) or it doesn't (left alone). There's no two-step state to get half-done.
- **Device stale-flag pass**: only touches rows where `stale_flagged_at IS NULL`, so a
  row that already got flagged is excluded from the next run's `WHERE` clause —
  re-running against already-flagged devices is a no-op.
- **Envelope GC**: same reasoning as prekey GC — a single-statement `DELETE ... WHERE`.
- **File hard-delete — the one two-step case**: this is the pass where crash-safety
  actually has to be designed for, because deleting the S3 object and marking the
  database row are two separate operations that can't be wrapped in one transaction (the
  object store isn't Postgres). The job orders them deliberately:

  > delete the S3 object first, and only set `hard_deleted_at` **after** that delete
  > succeeds.

  If the process crashes (or the DB write fails) between those two steps, the object is
  already gone from S3 but `hard_deleted_at` is still `NULL`. On the next tick, the file
  is picked up as a candidate again; the re-check query finds no live reference, and the
  code calls `deleteObject()` a second time. Object stores generally treat deleting an
  already-absent key as a success (or the client's error is caught and logged and the row
  is retried again next tick) rather than a hard failure, so the retry converges instead
  of raising an inconsistency. The failure mode this ordering rules out is the opposite
  one — flagging `hard_deleted_at` and then crashing *before* the S3 delete actually runs,
  which would permanently orphan the object with no job left to clean it up. See
  `fileCleanup.test.ts`'s `'does not mark hardDeletedAt when S3 delete throws (safe
  retry)'` case for the regression test on this ordering.
- **Pending-upload GC**: same object-then-row ordering as hard-delete, same retry
  argument — a crash between the S3 delete and the Postgres row delete just means the
  row is deleted again (already-gone-in-S3, still-present-in-Postgres) on the next tick.
- **Push backoff re-enable**: a single `UPDATE ... WHERE disabled_at <= NOW()` — the
  `WHERE` clause makes re-running it against already-cleared rows a no-op.

## Multi-node deployment implications

All six passes are started unconditionally in [`index.ts`](../src/index.ts) —
`startFileCleanupJob()`, `startDeviceGcJob()`, `startEnvelopeGcJob()` — with **no leader
election, no distributed lock, and no "only run on node 0" guard**. That means:

- **Every gateway node runs every job, on its own timer, independently.** In an N-node
  deployment, N processes are issuing the same `DELETE ... WHERE <cutoff>` /
  `UPDATE ... WHERE <cutoff>` queries against the same Postgres database on overlapping
  schedules.
- This is safe *because* every pass above is idempotent (see the previous section): a
  row is only affected while it still matches the `WHERE` clause, so two nodes racing to
  delete/flag the same row just means one of them does the work and the other's query
  matches zero rows. Nothing double-decrements or double-processes.
- The cost is redundant work, not correctness risk: N nodes each executing the same scan
  and (mostly no-op) `DELETE`/`UPDATE` every tick is wasted query load that scales
  linearly with node count, and N nodes each calling `deleteObject()` for the same S3 key
  around the same time is wasted object-store calls (again safe, since a repeat delete of
  an already-gone key is not an error).
- **Timers are not synchronized across nodes.** Each node starts its own `setInterval`
  from its own boot time, so in practice the N nodes' ticks are staggered, which spreads
  the redundant load out somewhat rather than having every node hit the database in the
  same instant — but this is incidental, not a designed-in stagger.
- If this redundant load ever becomes a real concern at higher node counts, the fix is to
  gate `startDeviceGcJob()` / `startEnvelopeGcJob()` / `startFileCleanupJob()` behind a
  single-designated-node check (e.g. lowest pod ordinal, or a Redis lock) rather than
  changing the jobs' own logic — the jobs themselves don't need to change since they're
  already safe to run from any single node.
