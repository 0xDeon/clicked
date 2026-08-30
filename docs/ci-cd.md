# CI/CD Pipeline Reference

This document describes every GitHub Actions workflow in `.github/workflows/`: what
triggers each one, what it runs, and what a failure means for a contributor.

## Contents

- [Path-filtered app workflows](#path-filtered-app-workflows)
  - [backend-ci](#backend-ci)
  - [frontend-ci](#frontend-ci)
  - [contracts-ci](#contracts-ci)
  - [ai-agent-ci](#ai-agent-ci)
- [security-ci](#security-ci)
- [loadtest-nightly](#loadtest-nightly)
- [pr](#pr)
- [Repo-hygiene automation](#repo-hygiene-automation)
  - [guard-main-branch](#guard-main-branch)
  - [close-linked-issues](#close-linked-issues)

## Path filters, in general

Four workflows (`backend-ci`, `frontend-ci`, `contracts-ci`, `ai-agent-ci`) restrict
themselves to `push`/`pull_request` events whose changed files match a `paths:` filter
for one app directory, plus the workflow's own YAML file. GitHub Actions evaluates the
filter before deciding whether to even queue the workflow, so a PR that only touches,
say, `apps/web/**` will show a run for `frontend-ci` but **no run at all** for
`backend-ci`, `contracts-ci`, or `ai-agent-ci` — those checks are silently skipped, not
run-and-passed. Conversely, a PR that touches multiple app directories (e.g. a shared
type used by both frontend and backend) triggers every matching workflow.

Practical implications:

- If your PR is supposed to gate on a workflow and you don't see it appear in the
  checks list, the most likely explanation is that your diff doesn't touch that app's
  path filter — not that the workflow is broken.
- Editing a workflow file itself (e.g. `.github/workflows/backend-ci.yml`) also
  triggers that workflow, so changes to the pipeline are self-testing.
- `security-ci` and `pr` have **no path filter** — they run on every push/PR
  regardless of which files changed (see their sections below).

---

## Path-filtered app workflows

### backend-ci

File: `.github/workflows/backend-ci.yml`

| | |
|---|---|
| Trigger | `push` and `pull_request` where the diff touches `apps/backend/**` or the workflow file itself |
| Services | Postgres 16 (`localhost:5432`, db `clicked`), Redis 7 (`localhost:6379`) |
| Jobs | Single job `check` ("Format · Lint · Test") |

Steps, in order:

1. Checkout, set up Node 20 and pnpm.
2. `pnpm install --frozen-lockfile` (repo root).
3. Start a MinIO container (`minio/minio:RELEASE.2025-04-22T22-12-26Z`) manually via
   `docker run`, wait for `/minio/health/ready`, then create the `clicked` bucket with
   the AWS SDK (MinIO isn't a `services:` container — it's started by hand so the
   bucket-creation script can run against it).
4. `pnpm db:migrate` against the Postgres service.
5. `pnpm format:check`
6. `pnpm lint`
7. `pnpm test`

**Failure signal**: a failing step points at exactly one of format, lint, migration, or
test — the step names in the Actions log say which. A migration failure often means a
new migration file doesn't apply cleanly against a fresh database, not a code bug.

### frontend-ci

File: `.github/workflows/frontend-ci.yml`

| | |
|---|---|
| Trigger | `push` / `pull_request` touching `apps/web/**` or the workflow file |
| Jobs | Single job `check` ("Lint · Build") |

Steps: checkout, Node 20 + pnpm, `pnpm install --frozen-lockfile`, then
`pnpm --filter web lint`, `pnpm --filter web test`, `pnpm --filter web build`, in that
order. No services are needed — this workflow is pure static analysis, unit tests, and
a production build of the `web` package.

**Failure signal**: lint failures are style/type issues; a `test` failure is a broken
unit test; a `build` failure usually means a type error or bundler error that only
surfaces at build time (dead code, unresolved import, etc.).

### contracts-ci

File: `.github/workflows/contracts-ci.yml`

| | |
|---|---|
| Trigger | `push` / `pull_request` touching `contracts/**` or the workflow file, **plus** a weekly `schedule` (`0 8 * * 1` — every Monday 08:00 UTC) |
| Toolchain | `dtolnay/rust-toolchain@stable`, pinned by `contracts/rust-toolchain.toml` (`channel = "stable"`, target `wasm32-unknown-unknown`, components `clippy`, `rustfmt`) |
| Jobs | `test-and-build` (matrix), `clippy`, `audit` |

**`test-and-build`** runs as a matrix over three Soroban contract packages —
`token_transfer`, `group_treasury`, `proposals` — each with `fail-fast: false` so one
package's failure doesn't cancel the others. Per package it:

1. Installs the Rust stable toolchain + `wasm32-unknown-unknown` target.
2. Caches `~/.cargo/registry`, `~/.cargo/git/db`, and `contracts/target`, keyed by
   `hashFiles('contracts/Cargo.lock')` (per-package cache key).
3. `cargo test -p <package>`.
4. `cargo build -p <package> --target wasm32-unknown-unknown --release`.
5. Installs `gh` (GitHub CLI) and runs the **WASM size gate** (see below).

**WASM size gate + PR comment** (`Report WASM binary sizes` step, `if: always()` so it
runs even after a test/build failure): it scans every `*.wasm` file under
`contracts/target/wasm32-unknown-unknown/release`, computes byte and KB size for each,
and builds a markdown table. `THRESHOLD_BYTES=102400` (100 KB) — any WASM binary over
that size emits a `::error` annotation and sets `FAILED=1`, so the job exits non-zero
at the end of the step even if `cargo build` itself succeeded. The size table is always
appended to `$GITHUB_STEP_SUMMARY`. On `pull_request` events specifically, the step
also posts/updates a PR comment: it searches existing PR comments for one whose body
starts with the marker `<!-- wasm-size-report -->` via `gh api ... --jq`, and either
`PATCH`es that comment in place or creates a new one — so repeated pushes to the same
PR update a single comment rather than spamming new ones on every run.

**`clippy`** job: installs the same pinned toolchain (with `clippy` component), reuses
a workspace-wide cache key, and runs
`cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings -A dead_code -A clippy::too-many-arguments`
— all warnings are denied except `dead_code` and `too-many-arguments`, which are
explicitly allowed.

**`audit`** job: installs `cargo-audit` and runs `cargo audit` against the workspace
for known security advisories in Rust dependencies.

**Failure signal**:
- `test-and-build` failing on `cargo test` = a contract logic/unit-test regression in
  that specific package (check the matrix leg name).
- `test-and-build` failing only on the size-gate step with a `cargo build` that
  otherwise succeeded = the built WASM crossed the 100 KB ceiling; check the PR
  comment / job summary table for which contract and by how much.
- `clippy` failing = a new clippy warning (lint), not a runtime bug.
- `audit` failing = a `RUSTSEC` advisory affecting a dependency version currently
  pinned in `contracts/Cargo.lock`.

**Toolchain-pinning caveat**: `contracts/rust-toolchain.toml` pins `channel = "stable"`
— not an exact version. `dtolnay/rust-toolchain@stable` therefore always installs
whatever the *current* stable Rust release is, which drifts over time. The scheduled
Monday run means this can go red **with zero code changes**, purely because a new
stable Rust release shipped a new warning, a clippy lint got stricter, or standard
library/codegen changes shifted a release WASM binary's size across the 100 KB
threshold. If `contracts-ci` fails on `main`/`dev` without a corresponding contracts
change, check the Rust release notes for the week before assuming a code regression.

### ai-agent-ci

File: `.github/workflows/ai-agent-ci.yml`

| | |
|---|---|
| Trigger | `push` / `pull_request` touching `apps/ai_agent/**` or the workflow file |
| Jobs | `lint`, `typecheck`, `test` (independent, all run `working-directory: apps/ai_agent`) |

All three jobs use `astral-sh/setup-uv@v5` (cache keyed on
`apps/ai_agent/uv.lock`) and `uv sync --group dev`.

- **`lint`**: `uv run ruff check .` then `uv run ruff format --check .`.
- **`typecheck`**: `uv run mypy main.py`.
- **`test`**: `uv run pytest --cov=main --cov-report=xml --cov-report=term-missing`,
  uploads coverage to Codecov (`continue-on-error: true` — a Codecov upload failure
  does not fail the job), then appends a markdown coverage table to
  `$GITHUB_STEP_SUMMARY` (falls back to a "Coverage data not available." note if
  `coverage report` fails, `if: always()` so this runs even after a test failure).

**Failure signal**: `lint`/`typecheck` failures are style/type issues in the Python
agent code; `test` failures are pytest assertion failures — check the coverage
summary/XML for which module regressed.

---

## security-ci

File: `.github/workflows/security-ci.yml`

| | |
|---|---|
| Trigger | `push` to `main`, and **every** `pull_request` (no path filter, no branch filter on the PR side) |
| Jobs | `regression`, `dependency-audit` (independent) |

Unlike the four workflows above, `security-ci` has no `paths:` filter, so it runs on
every PR regardless of which files changed.

- **`regression`** ("Ciphertext-only guard + secret-field scan"): installs Node 20 +
  pnpm, `pnpm install --frozen-lockfile`, then runs
  `pnpm test -- security.regression.test.ts` in `apps/backend`, i.e. specifically
  `apps/backend/src/__tests__/security.regression.test.ts`. This is the test suite that
  guards against private keys / session-state fields leaking outside of ciphertext.
- **`dependency-audit`** ("Crypto dependency CVE audit"): runs
  `node scripts/audit-crypto-deps.mjs`, which shells out to `pnpm audit --json` and
  filters advisories down to a fixed allowlist of crypto-relevant packages:
  `ioredis`, `jsonwebtoken`, `web-push`, `@stellar/stellar-sdk`, `drizzle-orm`,
  `socket.io`, `@socket.io/redis-adapter`, `redis`, `jose`. Advisories against
  transitive dependencies outside that list do not fail the job.

**Failure signal**: `regression` failing means a change altered behavior the
ciphertext/secret-field guard test depends on — treat this as a potential plaintext
leak of keys or session state until proven otherwise, not a flaky test to retry.
`dependency-audit` failing means a new CVE was published against one of the nine
crypto-relevant packages above (or one of their dependents) — check the job output for
the specific advisory and affected version range.

---

## loadtest-nightly

File: `.github/workflows/loadtest-nightly.yml` (workflow name: `Nightly Load Test`)

| | |
|---|---|
| Trigger | `schedule` — `0 3 * * *` (03:00 UTC nightly) — and `workflow_dispatch` (manual) |
| Services | Postgres 15, Redis 7 |
| Timeout | 20 minutes |

This is a soak test, not a per-PR gate — it is deliberately not wired to `push` or
`pull_request`, so it never blocks a merge. Use `workflow_dispatch` to run it manually
before merging changes to the load-test scripts or gateway fan-out logic.

Steps:

1. Boot Postgres + Redis, `pnpm install --frozen-lockfile`, run `pnpm db:migrate`.
2. Start **two** backend instances (`pnpm dev`) on ports 3001 and 3002, both pointed at
   the same `REDIS_URL` — this exercises Socket.IO fan-out and presence churn across
   node boundaries via `@socket.io/redis-adapter`, which single-node CI can't catch.
3. Wait for both `/health` endpoints.
4. Seed a 200-device fixture: `npx tsx scripts/loadtest/seed.ts --devices 200 > fixture.json`.
5. Run the soak test:
   `npx tsx scripts/loadtest/run.ts --fixture fixture.json --nodes http://localhost:3001,http://localhost:3002 --baseline scripts/loadtest/baseline.json --out loadtest-result.json`.
6. Always upload `loadtest-result.json` as a workflow artifact (`if: always()`), so a
   failed run's data is still retrievable.

**Baseline-regression comparison**: `scripts/loadtest/baseline.json` is a **static,
committed file** in the repo (not generated or updated by any workflow — no job in
this repo writes back to it). Its current contents:

```json
{
  "deviceCount": 200,
  "nodeCount": 2,
  "latencyMs": { "p50": 80, "p95": 400, "p99": 900 },
  "peakRssMb": 350
}
```

`scripts/loadtest/run.ts` reads this file when `--baseline` is passed and compares the
current run's summary against it with a fixed `REGRESSION_TOLERANCE = 1.25` (25%):
the run fails if `summary.latencyMs.p95 > baseline.latencyMs.p95 * 1.25` or
`summary.peakRssMb > baseline.peakRssMb * 1.25`. If the baseline file is missing or
unparsable, the script logs `no usable baseline at <path>, skipping regression check`
and does not fail the run on that account. Because nothing updates this file
automatically, a deliberate, accepted performance change (e.g. a heavier feature that
legitimately raises p95 latency or memory) will keep failing every night until someone
manually edits `scripts/loadtest/baseline.json` to the new numbers.

**Failure signal**: a failure is either a threshold breach inside `run.ts` (latency,
memory, or error-rate thresholds) or the 25%-worse-than-baseline regression check.
Since this only runs nightly/on-demand, a red run does not block any PR — but it
signals a real regression introduced sometime in the prior day's merges, and the
uploaded `loadtest-result.json` artifact has the concrete numbers to start from.

---

## pr

File: `.github/workflows/pr.yml` (workflow name: `PR Check`)

| | |
|---|---|
| Trigger | `pull_request`, types `opened`, `synchronize`, `reopened` (no path filter) |
| Jobs | Single job `build` |

Steps: checkout, Node 18.x, `npm i -g pnpm && pnpm install` (root-level, no
`--frozen-lockfile`), then `pnpm run lint`.

This is a lightweight, repo-wide lint gate that runs on every PR regardless of which
paths changed — distinct from the per-app `lint` steps inside `backend-ci` /
`frontend-ci`, which only run when their respective app directories are touched. Note
it uses `npm` (not `pnpm`) to *install* pnpm itself, and does not use `--frozen-lockfile`,
so it will still install even if the lockfile is stale (unlike the other workflows).

**Failure signal**: a failing `pnpm run lint` here is a whole-repo lint violation —
check which workspace package the lint error is reported against.

---

## Repo-hygiene automation

These two workflows don't test code — they enforce the repo's branching policy and
issue-closing behavior. Both use `pull_request_target` (runs with write-level
permissions and repo-owner secrets even for PRs opened from forks) and
`actions/github-script@v7` to call the GitHub API directly.

### guard-main-branch

File: `.github/workflows/guard-main-branch.yml`

| | |
|---|---|
| Trigger | `pull_request_target`, types `opened`, `reopened`, `edited`, `ready_for_review`, only when `branches: [main]` |
| Permissions | `pull-requests: write` |

This is the actual mechanism behind the "only `dev` accepts contributor PRs, `main` is
maintainer-only" rule described elsewhere in the repo docs. On every qualifying event
it:

1. Re-checks `pr.base.ref === 'main'` (relevant because `edited` fires even when the PR
   is edited to no longer target `main`) — if the base branch isn't `main` anymore, it
   no-ops.
2. Determines whether the PR author is allowed to target `main`: the repo owner
   (`context.repo.owner`) is always allowed; otherwise it looks up the author's
   collaborator permission level via `getCollaboratorPermissionLevel` and allows
   `admin` or `maintain`. Anyone else — including a normal `write`-level collaborator —
   is treated as disallowed. A non-collaborator (typical fork contributor) is caught
   by the `try`/`catch` and also treated as disallowed.
3. If disallowed: posts a comment explaining that PRs must target `dev`, then closes
   the PR (`state: 'closed'`) via the API — it does not merge, retarget, or delete
   anything, just closes.

**Failure signal**: there's no pass/fail check here in the traditional CI sense — the
"signal" is the PR itself being auto-closed with an explanatory comment. If your PR
against `main` disappears/closes immediately, this workflow did it; retarget to `dev`
and reopen (or open a fresh PR against `dev`).

### close-linked-issues

File: `.github/workflows/close-linked-issues.yml` (workflow name: `Close Linked Issues
on Dev Merge`)

| | |
|---|---|
| Trigger | `pull_request_target`, type `closed`, only when `branches: [dev]` |
| Permissions | `issues: write` |
| Guard | job-level `if: github.event.pull_request.merged == true` (skips PRs that were closed without merging) |

GitHub's native "Closes #N" auto-close behavior only fires when a PR merges into the
repository's **default branch**. Since this repo's contributor workflow merges PRs into
`dev` rather than `main`, that native behavior never fires — this workflow re-implements
it for `dev` merges:

1. Concatenates the merged PR's title + body.
2. Regex-matches closing keywords: `close(s|d)`, `fix(es|ed)`, `resolve(s|d)` followed
   by `#<number>` (case-insensitive, optional colon), de-duplicating issue numbers.
3. For each matched issue number: skips it if the number actually refers to a PR, or if
   the issue is already closed; otherwise posts a
   `Closed by #<PR>, merged into \`dev\`.` comment and closes the issue with
   `state_reason: 'completed'`.
4. Any per-issue API error is caught and logged as a `core.warning` without failing the
   whole job (so one bad issue number doesn't block the others).

**Failure signal**: this workflow has no build/test output to fail in the usual sense.
If an issue you expected to auto-close after a `dev` merge is still open, check that
the PR title/body actually used one of the recognized keyword forms (`closes #123`,
`fixes #123`, `resolves #123`, etc.) — free-text like "related to #123" or "see #123"
is intentionally not matched.
