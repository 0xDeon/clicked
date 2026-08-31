# Troubleshooting and FAQ

Failures contributors actually hit in this repo, with the symptom, the underlying cause,
and the fix. For workflow-by-workflow CI mechanics, see [`docs/ci-cd.md`](./ci-cd.md); for
first-time environment setup, see [`docs/development-setup.md`](./development-setup.md)
(its own §9 covers a few setup-time issues not repeated here).

## Contents

- [`pnpm install` fails on a lockfile/package.json mismatch](#pnpm-install-fails-on-a-lockfilepackagejson-mismatch)
- [My migration didn't run](#my-migration-didnt-run)
- ["Works locally, fails in CI" — floating toolchains](#works-locally-fails-in-ci--floating-toolchains)
- [Tests interfere with each other through shared in-process counters](#tests-interfere-with-each-other-through-shared-in-process-counters)
- [Web app fails to build after a dependency drift](#web-app-fails-to-build-after-a-dependency-drift)

---

## `pnpm install` fails on a lockfile/package.json mismatch

**Symptom**: `pnpm install --frozen-lockfile` (what every CI workflow runs — see
`backend-ci.yml`, `frontend-ci.yml`, `loadtest-nightly.yml`) fails with something like
`ERR_PNPM_OUTDATED_LOCKFILE` / "Lockfile is not up to date with package.json", even
though `pnpm install` (no flag) works fine on your machine.

**Cause**: this repo has more committed lockfiles than a single pnpm workspace should
have:

```
pnpm-lock.yaml              ← the one CI actually installs from (root workspace)
package-lock.json           ← an npm lockfile, also committed, at the root
apps/backend/pnpm-lock.yaml ← a second pnpm lockfile, inside a workspace package
apps/web/pnpm-lock.yaml
apps/web/pnpm-workspace.yaml← declares apps/web as its own pnpm workspace root
apps/web/package-lock.json  ← an npm lockfile for apps/web, also committed
```

The root `pnpm-workspace.yaml` (`packages: ['apps/*', 'contracts']`) is the one CI's
`pnpm install --frozen-lockfile` resolves against, using the root `pnpm-lock.yaml`. But
`apps/web/pnpm-workspace.yaml` means that if you `cd apps/web && pnpm install` directly
(a natural thing to do while working on just the frontend), pnpm treats `apps/web` as an
**independent workspace root** and installs against `apps/web/pnpm-lock.yaml` instead —
a completely separate resolution, with its own `node_modules`, that has no relationship
to the root lockfile CI uses. Editing `apps/web/package.json` and installing from inside
`apps/web` updates the *nested* lockfile; the root `pnpm-lock.yaml` is left stale, and
`--frozen-lockfile` at the root then refuses to proceed because it (correctly) sees a
`package.json` that no longer matches the committed root lockfile. Running `npm install`
anywhere in the tree instead of `pnpm install` has the same effect via the npm lockfiles.

A real instance of this: commit `46eee04` ("fix: update lockfile for new backend deps,
format fanout.ts") exists specifically because `pnpm-lock.yaml was stale after adding
prom-client/pino to apps/backend/package.json, which would fail --frozen-lockfile in the
new security-ci.yml workflow" — a dependency was added to `apps/backend/package.json`
without the root lockfile being regenerated in the same change.

**Fix**:

- Always run `pnpm install` from the **repo root**, never from inside `apps/web` or
  `apps/backend` — `corepack enable` first so the pinned `pnpm@10.28.1` is used (see
  `docs/development-setup.md` §2).
- After changing any workspace package's `package.json` (adding/bumping a dependency),
  regenerate the **root** lockfile before committing: `pnpm install` from the root, then
  check `git diff pnpm-lock.yaml` is included in your change.
- Do not commit changes to `package-lock.json`, `apps/web/package-lock.json`,
  `apps/web/pnpm-lock.yaml`, or `apps/backend/pnpm-lock.yaml` — they are not what CI
  installs from; if your editor/IDE or a stray `npm install` touched one, revert it
  (`git checkout -- <path>`) before committing.
- If CI is failing with an outdated-lockfile error, diff your branch's root
  `pnpm-lock.yaml` against `main`'s — if it didn't change but `package.json` did, that's
  the mismatch.

---

## My migration didn't run

**Symptom**: you added a new Drizzle migration file under `apps/backend/drizzle/`
(usually via `pnpm db:generate`), it's committed, `pnpm db:migrate` exits `0` with no
error — but the column/table it should have added isn't actually in the database, and
your code that depends on it fails at runtime with a Postgres "column does not exist"
error, not a migration error.

**Cause**: `drizzle-kit migrate` doesn't scan the `drizzle/` directory for `.sql` files
directly — it reads `apps/backend/drizzle/meta/_journal.json`, which is the ordered list
of migrations it considers to exist:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    { "idx": 0, "version": "7", "when": 1787281148373, "tag": "0000_lean_scrambler", "breakpoints": true }
  ]
}
```

A `.sql` file sitting in `drizzle/` with no corresponding `entries[]` row in
`_journal.json` is invisible to `db:migrate` — it is **silently skipped**, not an error,
because as far as the journal is concerned that migration doesn't exist. This is
different from every other failure in this document: there is no red build, no stack
trace, nothing in CI logs to point at. The only signal is application code breaking
against a schema that looks like it should have the change but doesn't.

This repo has already been through one event that makes this easy to trigger: commit
`d60b648` ("fix(major): full fix") collapsed seven separate migration files
(`0001_add_system_payload_to_messages.sql`, `0001_audit_logs.sql`,
`0001_device_key_history.sql`, `0001_gc_background_jobs.sql`,
`0001_group_control_events.sql`, `0001_mls_group_state.sql`, `0001_mls_key_packages.sql`,
plus a `0002_*` and a `0003_*`) into the single `0000_lean_scrambler.sql` now in the repo,
rewriting `meta/_journal.json` in the same commit. Two ways this bites a contributor
today:

- **A merge conflict on `meta/_journal.json`** resolved by taking "theirs" (or a stale
  rebase) can drop your branch's newly-generated `entries[]` row while your `.sql` file
  itself survives the merge untouched — the file is on disk, but the journal no longer
  lists it.
- **Editing schema.ts and hand-writing a migration file** instead of running
  `pnpm db:generate` skips the step that appends the journal entry — `drizzle-kit
  generate` is what keeps the `.sql` file and the journal row in sync; writing the SQL by
  hand does not.

**Fix**:

- Always create migrations with `pnpm --filter backend db:generate` (or `pnpm db:generate`
  from `apps/backend/`) after changing `src/db/schema.ts` — never hand-write a `.sql` file
  under `drizzle/` and expect `db:migrate` to pick it up.
- After generating, confirm `git status` shows **both** the new `drizzle/NNNN_*.sql` file
  **and** an updated `drizzle/meta/_journal.json` (with a new `entries[]` row) — a
  migration PR that touches the `.sql` file but not `_journal.json` is missing its journal
  entry.
- If you suspect a migration silently didn't run, check the database directly: Drizzle's
  migrator tracks applied migrations in Postgres (in the `drizzle` schema's own migrations
  table) — compare what's recorded there against `meta/_journal.json`'s `entries[]`. If a
  tag is in the journal but not in the database's applied-migrations table, `db:migrate`
  will still apply it on the next run — it errors loudly if a truly out-of-order state
  exists. If a tag is missing from the journal entirely, re-add the correct `entries[]`
  row (matching its `tag` to the `.sql` filename, `idx` to its position) and re-run
  `pnpm db:migrate`.

---

## "Works locally, fails in CI" — floating toolchains

**Symptom**: `pnpm lint`, `pnpm test`, or `cargo test`/`cargo build` passes on your
machine but fails in the matching GitHub Actions workflow (or vice versa: green in CI,
red for a teammate), with no relevant diff between what you pushed and what's checked
out.

**Cause 1 — inconsistent Node pin across workflows.** `backend-ci.yml`, `frontend-ci.yml`,
and `security-ci.yml` all set up **Node 20**, but `pr.yml` ("PR Check") still pins
**Node 18.x**. There is no `.nvmrc`/`.node-version` file and no root `engines` field
pinning a Node version for local dev, so a contributor's local Node (whatever `nvm`/
`asdf`/system default happens to resolve to) can legitimately differ from both. A
Node-version-sensitive change (a newer built-in, a runtime behavior difference) can pass
under one workflow's Node and fail under another's, or pass locally and fail in
`pr.yml`'s older Node.

- **Fix**: treat Node **20** as the source of truth for local dev (per
  `docs/development-setup.md`) — install it via `corepack`/`nvm`. If a `pr.yml`-specific
  failure doesn't reproduce under Node 20, the fix belongs in `pr.yml` (bump it to 20 to
  match the rest), not in application code.

**Cause 2 — `contracts/rust-toolchain.toml` pins `channel = "stable"`, not a version.**
`stable` resolves to whatever the latest stable Rust release is *at the moment `rustup`
installs it* — a fresh CI runner and your local machine (toolchain installed however long
ago) can silently be on different actual compiler versions, which occasionally changes
clippy's lint set or accepts/rejects different code. `contracts-ci.yml` runs on a weekly
schedule (`0 8 * * 1`, every Monday) in addition to push/PR specifically because a `stable`
channel can start failing with **no code change at all** — the toolchain itself moved.

- **Fix**: if `cargo test`/`cargo clippy` fails in CI but not locally (or the reverse),
  run `rustup update` locally to pick up the same `stable` CI is on, rather than assuming
  your code is wrong. If a weekly scheduled `contracts-ci` run goes red with no merged
  changes since the last green run, that's this — the fix is almost always a small clippy/
  compiler-compat patch, not a revert.

---

## Tests interfere with each other through shared in-process counters

**Symptom**: a backend test passes in isolation (`vitest run path/to/file.test.ts -t
'that one test'`) but fails when the full file or suite runs — often a rate-limit,
backoff, or violation-count assertion that expects a fresh counter but sees leftover state
from an earlier `it()` block in the same file.

**Cause**: several backend services intentionally keep their working state in a
module-level `Map`/`Set` rather than Redis, either as a same-process fallback (rate
limiting when Redis is unreachable) or because the state is inherently per-process
(heartbeat timers, socket-scoped violation counts):

| Module | State | Reset export |
|---|---|---|
| `services/rateLimiter.ts` | `localCounters: Map` (fallback counters used only while Redis is down) | `clearLocalRateLimitCounters()` |
| `services/rateLimit.ts` | `violationCount: Map` | `clearViolations(socketId)` |
| `services/prekeyLowSignal.ts` | `localLatch: Set` | `__resetPrekeyLowLatches()` |
| `services/presence.ts` | `pendingOfflineBroadcasts: Map` | `__resetOfflineBroadcastsForTesting()` |
| `services/heartbeat.ts` | `timers`/`lastSeenAt`/`schedules: Map` | `clearHeartbeatTimer(socketId)` (per-socket, not a full reset) |

Because Vitest runs every `it()` in a file against the **same imported module instance**
(module isolation is per-file, not per-test), this state persists across test cases
within a file unless a test explicitly clears it. A test that relies on a fresh counter
but forgets the reset call — commonly because a new test was added to an existing
`describe` block without also adding it to that block's `beforeEach` — passes or fails
depending on what ran before it in the same file, which is exactly the "passes alone,
fails in the suite" (or the reverse, and sometimes order-dependent) symptom.
`apps/backend/src/__tests__/rateLimit.test.ts` shows the pattern to follow:

```ts
describe('checkSocketEventRateLimit', () => {
  beforeEach(() => {
    clearLocalRateLimitCounters();
  });
  // ...
});
```

**Fix**:

- When writing a test against a service with module-level state, check whether it exports
  a reset/clear function (see table above) and call it in `beforeEach`/`afterEach` for
  every `describe` block that exercises that state — not just the first one added.
  Copy-pasting an existing `it()` into a new `describe` block without also copying its
  `beforeEach` is the most common way this regresses.
  - `clearViolations`/`clearHeartbeatTimer` take a socket ID and only clear that entry —
    use a fresh, unique socket/device ID per test as the simpler alternative to a global
    reset where the module doesn't expose one.
- If a test is flaky specifically when run as part of the full suite but not alone, don't
  assume the test itself is broken — grep the module it exercises for a module-level
  `Map`/`Set`/`let` (`grep -n "^const .* = new Map\|^let " src/services/*.ts`) before
  looking anywhere else.
- Do not add new cross-request/cross-test process state to a service without also adding
  a `__resetXForTesting()`-style export — the pattern above only works because every
  stateful module has one.

---

## Web app fails to build after a dependency drift

**Symptom**: `pnpm --filter web build` (or the `frontend-ci.yml` "Build" step) fails after
a `package.json` change to `apps/web` — a version-resolution error, a type error that
wasn't there before, or a build-time error from a package that built fine yesterday —
even though the diff "only" touched a dependency.

**Cause**: this is the same nested-workspace mechanism described in
[the lockfile section above](#pnpm-install-fails-on-a-lockfilepackagejson-mismatch),
manifesting as a build failure instead of an install failure. `apps/web/pnpm-workspace.yaml`
makes `apps/web` installable as its own standalone pnpm root, with its own `pnpm-lock.yaml`
and its own resolved `node_modules` tree, entirely separate from the root workspace's
hoisted layout. If dependency resolution happens against the nested lockfile locally (via
`cd apps/web && pnpm install`) but the root workspace's `pnpm-lock.yaml` resolved different
versions the last time it was regenerated, `apps/web`'s effective dependency tree can
silently diverge between "what you built against locally" and "what `frontend-ci.yml`
installs from the root and builds against" — a transitive version bump in one lockfile but
not the other is enough to change type-checking output (`react`/`@types/react` version
skew is a common one, given `apps/web/package.json` pins `react`/`react-dom` at exact
`19.2.4` but `@types/react`/`@types/react-dom` only at `^19` — a nested vs. root
resolution can legitimately land on different patch versions of the types package).

**Fix**:

- Same root fix as the lockfile section: install and build from the repo root
  (`pnpm install`, then `pnpm --filter web build`), never from inside `apps/web` directly.
- If a build failure only reproduces with a fresh `node_modules` (e.g. after `rm -rf
  node_modules && pnpm install` at the root), suspect a resolution difference rather than
  a real code regression — compare the installed version of the package named in the
  error (`pnpm why <package> --filter web`) against what's pinned in
  `apps/web/package.json` and what the root `pnpm-lock.yaml` actually resolved.
- Before debugging a build error as an application bug, confirm `apps/web/pnpm-lock.yaml`
  and `apps/web/package-lock.json` haven't drifted from the root `pnpm-lock.yaml` — if
  they have, they're stale artifacts (see above) and should not be committed alongside
  your change; regenerate the root lockfile instead.
