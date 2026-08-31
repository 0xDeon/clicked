# Load and Soak Testing Guide

This document covers `scripts/loadtest/` — the harness that seeds a fixture, connects a
fleet of Socket.IO clients across one or more backend nodes, and drives a scripted
fan-out/churn/reconnect workload against them. For how this harness is wired into CI, see
the [`loadtest-nightly`](./ci-cd.md#loadtest-nightly) section of `docs/ci-cd.md` — this
document is about the scripts themselves: what they do, how to run them locally, what the
numbers mean, and how to maintain the regression baseline.

## Contents

- [What the harness exercises](#what-the-harness-exercises)
- [`seed.ts`](#seedts)
- [`run.ts`](#runts)
- [Required local topology](#required-local-topology)
- [The three phases](#the-three-phases)
- [Metrics and thresholds](#metrics-and-thresholds)
- [`baseline.json`](#baselinejson)
- [The nightly workflow, and what to do when it fails](#the-nightly-workflow-and-what-to-do-when-it-fails)

## What the harness exercises

`seed.ts` writes a fixture (users, devices, JWTs, one shared group conversation) straight
to Postgres via Drizzle. `run.ts` reads that fixture, connects every participant as a real
`socket.io-client`, splits those connections evenly across the node URLs you pass it, and
runs three phases against them — sampling process RSS every second throughout. Splitting
connections across multiple node URLs, all pointed at the same Redis, is the point of the
exercise: it's the only place in the repo's test suite that forces a message to fan out
*across* backend instances via `@socket.io/redis-adapter`, rather than within one
in-process `Server`. A single-node run is still useful (it's a valid, if less interesting,
topology) but doesn't exercise that cross-instance path.

## `seed.ts`

```bash
npx tsx scripts/loadtest/seed.ts --devices 200 > fixture.json
```

- Creates one `type: 'group'` conversation named `loadtest`.
- For each of `--devices` (default **200**) iterations: inserts a `users` row (random
  `loadtest-<hex>-<i>` username), one `devices` row for that user (`platform: 'web'`,
  random identity key), adds the user to the conversation via `conversationMembers`, and
  signs a JWT for that `(userId, deviceId)` pair with `signToken()` — the same signer the
  real auth path uses, so the fixture's tokens are accepted by `socketAuthMiddleware`
  exactly like a real client's.
- Writes the resulting `Fixture` — `{ conversationId, participants: [{ userId, deviceId,
  token }, ...] }` — to **stdout** as JSON. Progress/errors go to stderr, so
  `> fixture.json` captures only the fixture itself.
- Talks to the database directly (imports `db` and the schema from
  `apps/backend/src/...`) — it does not go through the HTTP/socket API to seed data, so it
  needs a reachable `DATABASE_URL` but not a running backend.
- The only flag is `--devices <n>`; an unparseable or non-positive value silently falls
  back to 200.

## `run.ts`

```bash
npx tsx scripts/loadtest/run.ts \
  --fixture fixture.json \
  --nodes http://localhost:3001,http://localhost:3002 \
  [--baseline scripts/loadtest/baseline.json] \
  [--out result.json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--fixture` | no (default `fixture.json`) | Path to the JSON file `seed.ts` produced. |
| `--nodes` | no (default `http://localhost:3001`) | Comma-separated backend base URLs. Participant `i` connects to `nodes[i % nodes.length]` — a simple round-robin, so device order in the fixture determines which node each device lands on. |
| `--baseline` | no | Path to a baseline JSON file (see [below](#baselinejson)). If omitted, the run still enforces the fixed `THRESHOLDS` but skips the regression comparison. |
| `--out` | no | If set, also writes the JSON summary to this path (in addition to stdout). |

Every socket connects with `transports: ['websocket']` and `reconnection: false` — the
harness handles reconnects itself (phases 2 and 3 below), so it doesn't want the client
library racing its own reconnect logic against the script's.

**Exit code**: `0` if every threshold and (when `--baseline` is given) the regression
check pass; `1` otherwise, or on a fatal error (e.g. a connect timeout during the initial
connect-all-devices step, before any phase runs). The JSON summary is printed to stdout
regardless of pass/fail; failure reasons are printed to stderr as `FAIL: ...` lines.

## Required local topology

To reproduce what the nightly workflow does on your own machine:

1. **Postgres and Redis reachable**, with `DATABASE_URL` / `REDIS_URL` pointed at them.
   `REDIS_URL` in particular has to be the *same* Redis for every backend node you start —
   that shared Redis is what lets `@socket.io/redis-adapter` fan a message out across
   nodes.
2. **Run migrations** (`pnpm --filter backend db:migrate`) before seeding — `seed.ts`
   writes through Drizzle against the real schema.
3. **Two (or more) backend instances**, each on its own `PORT`, e.g.:
   ```bash
   PORT=3001 pnpm --filter backend dev &
   PORT=3002 pnpm --filter backend dev &
   ```
   pointed at the same `DATABASE_URL`/`REDIS_URL`. Wait for both `/health` endpoints
   before proceeding — the nightly workflow polls this with a 30-retry/1s loop.
4. **Seed, then run**, from the repo root (the scripts import backend modules by relative
   path, so they expect to run from there):
   ```bash
   npx tsx scripts/loadtest/seed.ts --devices 200 > fixture.json
   npx tsx scripts/loadtest/run.ts --fixture fixture.json \
     --nodes http://localhost:3001,http://localhost:3002 \
     --baseline scripts/loadtest/baseline.json --out loadtest-result.json
   ```

A single-node run (`--nodes http://localhost:3001` only) works too and is a reasonable
smoke test, but it will not catch a cross-instance fan-out regression — use two nodes to
match what the nightly job actually validates.

## The three phases

Run in this order, against the same connected set of sockets:

1. **Fan-out latency.** One participant (`sockets[0]`) is the sender; every other
   connected socket is a recipient. The sender emits `send_message` with one envelope per
   recipient device (placeholder `ciphertext: 'loadtest-ciphertext'` — the harness isn't
   testing encryption, just delivery). Each recipient's `message_envelope` receipt is
   timestamped against the send time, producing one latency sample per recipient. The
   phase ends when every recipient has received it or after a 30-second timeout, whichever
   comes first; any recipients still missing at that point count as a fan-out error.
2. **Presence churn.** 20% of connected sockets (minimum 1) disconnect, wait 500ms,
   reconnect (against the same node-assignment rule), wait another 500ms — repeated for
   3 rounds. A reconnect that throws/times out is recorded as an error but does not abort
   the run.
3. **Reconnect storm.** Every socket disconnects at once, a 200ms pause, then every
   participant reconnects simultaneously. Failures are counted; all sockets are then
   disconnected again to close out the run.

Peak RSS (`process.memoryUsage().rss`, sampled every second via a background interval
that started before phase 1 and is cleared after phase 3) is the memory figure reported —
it's the load-test **client** process's own memory, not the backend's, so it primarily
tracks the socket.io-client fleet's footprint, not server-side memory pressure.

## Metrics and thresholds

The summary JSON:

```json
{
  "deviceCount": 200,
  "nodeCount": 2,
  "fanoutDelivered": 199,
  "fanoutExpected": 199,
  "latencyMs": { "p50": 80, "p95": 400, "p99": 900 },
  "peakRssMb": 350,
  "errorCount": 0,
  "errorRate": 0,
  "errors": []
}
```

- **`latencyMs.p50/p95/p99`** — percentiles over the fan-out phase's per-recipient
  latency samples only (churn and reconnect-storm timings aren't included in this
  distribution). `percentile()` sorts ascending and indexes at
  `floor((p/100) * length)`, i.e. nearest-rank, not interpolated.
- **`peakRssMb`** — the single highest RSS sample seen across the whole run (all three
  phases), rounded to the nearest MB.
- **`errorCount`** / **`errors`** — a flat list of string messages accumulated from any
  phase: missed fan-out receipts, failed churn reconnects, failed storm reconnects.
- **`errorRate`** — `errorCount / (participants.length * 4)`. The `* 4` denominator is a
  rough per-participant "opportunities to fail across all phases" estimate, not an exact
  count — treat `errorRate` as a normalized signal, not a precise fraction.

**Fixed thresholds** (`THRESHOLDS`, always enforced regardless of `--baseline`):

| Threshold | Value |
|---|---|
| `maxP95LatencyMs` | 1500 |
| `maxP99LatencyMs` | 3000 |
| `maxPeakRssMb` | 1024 |
| `maxErrorRate` | 0.01 |

Any one breach fails the run (exit code 1, with a `FAIL: ...` line on stderr naming which
threshold and by how much) and continues checking the rest — the printed `FAIL` lines from
one run can name multiple breaches at once.

## `baseline.json`

`scripts/loadtest/baseline.json` is a small, **statically committed** file — nothing in
the repo generates or writes it back automatically:

```json
{
  "deviceCount": 200,
  "nodeCount": 2,
  "latencyMs": { "p50": 80, "p95": 400, "p99": 900 },
  "peakRssMb": 350
}
```

It represents a known-good run's numbers, captured by hand at some point in the past, for
the same topology (`200` devices, `2` nodes) the nightly workflow uses. It exists to catch
*gradual* regressions the fixed `THRESHOLDS` are too loose to catch — e.g. p95 creeping
from 400ms to 900ms is still well under the fixed 1500ms ceiling but is a 2x-plus
regression against what this exact workload used to cost.

**Regression tolerance**: when `--baseline` is passed and the file parses, `run.ts`
compares only two fields, each against a fixed `REGRESSION_TOLERANCE = 1.25` (25%):

- fails if `summary.latencyMs.p95 > baseline.latencyMs.p95 * 1.25`
- fails if `summary.peakRssMb > baseline.peakRssMb * 1.25`

(`p50`/`p99`/error rate are not compared against the baseline — only p95 latency and peak
memory are.) If the baseline file is missing or fails to parse, the script logs
`no usable baseline at <path>, skipping regression check` and does **not** fail the run on
that account — a missing/corrupt baseline degrades to "threshold-only enforcement," not to
a hard failure.

**Refreshing the baseline**: because nothing writes this file automatically, a
legitimate, accepted change that raises latency or memory (a heavier feature, a new
per-message check, etc.) will fail the nightly run indefinitely until someone manually
updates it. To refresh it:

1. Confirm the new numbers are an accepted cost, not an unintended regression — read the
   failing run's uploaded `loadtest-result.json` artifact (or run the harness locally) and
   satisfy yourself the new latency/memory profile is expected given what changed.
2. Copy the new run's `latencyMs`, `peakRssMb` (and `deviceCount`/`nodeCount`, if the
   topology itself changed) into `scripts/loadtest/baseline.json`.
3. Commit that change on its own, with a message naming what caused the shift, so the
   baseline's history stays legible to whoever hits the next regression.

## The nightly workflow, and what to do when it fails

The full workflow mechanics (services, steps, triggers) are documented in
[`docs/ci-cd.md#loadtest-nightly`](./ci-cd.md#loadtest-nightly) — in short, it's a
`schedule`-triggered (03:00 UTC) and `workflow_dispatch`-triggered job that boots
Postgres + Redis + two backend instances (ports 3001/3002) sharing that Redis, seeds a
200-device fixture, and runs exactly the `run.ts` invocation shown above with
`--baseline scripts/loadtest/baseline.json`. It is **not** wired to `push`/`pull_request`,
so a red nightly run never blocks a merge — it's a signal about the prior day's merges,
not a gate.

When it fails:

1. **Download the `loadtest-result` artifact** (`loadtest-result.json`, uploaded via
   `if: always()` so it's there even on failure) from the workflow run — it has the exact
   numbers and the `errors` array.
2. **Read which check failed** from the job's log `FAIL: ...` lines — a fixed-threshold
   breach (real latency/memory/error problem, full stop) reads differently from a
   baseline-regression-only failure (numbers are still under the hard ceiling, just worse
   than they used to be).
3. **Reproduce locally** using the topology above if you need to bisect — run the harness
   before and after a suspected commit with the same `--devices`/`--nodes` to compare.
4. **If it's a real regression**, treat it like any other performance bug: find the commit
   (the workflow runs nightly, so the failure window is roughly "yesterday's merges to
   main"), fix it, and let the next nightly run confirm.
5. **If it's an accepted cost**, refresh `baseline.json` as described above rather than
   leaving the nightly job red — a baseline that no longer matches reality makes every
   future run's regression signal meaningless.
6. **Use `workflow_dispatch`** to re-run on demand rather than waiting for the next
   scheduled run, especially when validating a fix or a change to the load-test scripts
   or gateway fan-out logic themselves.
