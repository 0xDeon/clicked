# Testing strategy and conventions

How tests are written and run across the four apps in this repository. Read this before
adding a test to any suite — most of it is convention rather than tooling, and the
conventions exist because the alternatives have already broken this repository at least
once.

The contract test suite has its own, deeper guide:
[Contract testing guide](../contracts/docs/testing.md). This document covers the
cross-app rules and the JavaScript/TypeScript and Python suites.

---

## The rule that matters most: tests never start real external services

**No test in this repository may require Redis, Postgres, or an S3/MinIO server to be
running.** The test suites must pass on a laptop with Docker stopped, on a fresh clone,
with nothing but `pnpm install` done first.

This is not a stylistic preference:

- **A test that needs Docker is a test nobody runs.** The suite is the thing that catches a
  regression before review, and it only does that if running it costs one command and a few
  seconds. Every service a contributor has to remember to start is a reason the suite gets
  skipped locally and the failure gets discovered in CI instead.
- **Shared mutable state makes tests order-dependent.** A real Postgres or a real Redis is
  shared across every test file in the run. One test that forgets to clean up a row or a key
  produces a failure in an unrelated file, and the failure moves around as file order
  changes.
- **Speed is correctness pressure.** An in-process fake answers in microseconds. A suite
  that takes two minutes gets narrowed to "just the file I'm editing", and the cross-cutting
  regressions are exactly the ones that narrowing hides.

### Approved substitutes

| Real dependency                                               | What tests use instead                                              | How                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis                                                         | [`ioredis-mock`](https://github.com/stipsan/ioredis-mock)           | `import RedisMock from 'ioredis-mock'`, then `vi.mock('../lib/redis.js', () => ({ redis: sharedRedis, ... }))`. It is a faithful in-memory implementation of the command surface this codebase uses, including `scan`, `del`, and `flushall`.                                                                                     |
| Redis, when the code path should behave as if Redis is _down_ | `null`                                                              | `vi.mock('../lib/redis.js', () => ({ get redis() { return null; } }))`. Several modules degrade deliberately when Redis is absent — rate limiting falls back to per-process counters, the conversation cache becomes a pass-through — and those fallbacks need coverage too.                                                      |
| Postgres                                                      | A hand-built `db` mock                                              | `vi.mock('../db/index.js', ...)` with `vi.fn()` stubs for `query.*.findFirst` / `findMany`, `insert`, `update`, `delete`, `transaction`, and `execute`. See [The Drizzle mocking pattern](#the-drizzle-mocking-pattern). Drizzle's query builders are mocked, not driven — no SQL is generated and no connection is opened.       |
| S3 / MinIO                                                    | `LocalDiskObjectStore` (`apps/backend/src/lib/localObjectStore.ts`) | Outside production, `lib/storage.ts` already routes presigned PUT/GET through the fs-backed store, so upload and download paths are exercised end to end against real files under `apps/backend/.local-storage/` (git-ignored) with no S3 client involved. Tests that target the S3 SDK path itself mock `../lib/objectStore.js`. |
| IndexedDB (web)                                               | [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB)     | `import 'fake-indexeddb/auto'` at the top of the test file, before the module under test is imported.                                                                                                                                                                                                                             |
| WebCrypto / `window` / `btoa` (web)                           | `apps/web/src/test/setup.ts`                                        | The setup file installs `node:crypto`'s `webcrypto`, a `window`/`self` alias, and `btoa`/`atob` onto `globalThis`, so browser crypto code runs unchanged under the `node` environment. Do not re-polyfill these per test.                                                                                                         |
| OpenAI / Weaviate (AI agent)                                  | `pytest-mock` fixtures in `apps/ai_agent/tests/conftest.py`         | `mock_openai` patches `main.OpenAI`; `mock_weaviate` patches `main.weaviate.connect_to_local`. An autouse fixture sets a dummy `OPENAI_API_KEY` so the client constructor never 500s. No test makes a network call.                                                                                                               |
| Stellar / Soroban RPC                                         | The Soroban `Env` test harness                                      | `Env::default()` is a complete in-process ledger. Contract tests never talk to a network. See the [Contract testing guide](../contracts/docs/testing.md).                                                                                                                                                                         |

### Environment variables, not services

`apps/backend/src/__tests__/setup.ts` is registered as a Vitest `setupFiles` entry and sets
`JWT_SECRET`, `DATABASE_URL`, and the `OBJECT_STORE_*` variables to placeholder values.
Their only purpose is to satisfy config validation at import time — nothing connects to the
hosts they name. If a new module validates a new required variable at import, add a
placeholder there rather than mocking the config module in every test file.

### What CI does, and why it is not a licence to depend on services

The backend CI workflow does start Postgres, Redis, and MinIO containers. That is for the
`pnpm db:migrate` step, which validates that the generated migrations actually apply to a
real Postgres — not so that tests can reach them. The security workflow
(`.github/workflows/security-ci.yml`) runs backend tests with **no** service containers at
all, which is the standing proof that the suite is service-free. If a change makes the suite
depend on a running service, security CI is where it breaks.

---

## Runners and commands

| App             | Runner       | Command                             | Config                                          |
| --------------- | ------------ | ----------------------------------- | ----------------------------------------------- |
| `apps/backend`  | Vitest       | `pnpm --filter backend test`        | `apps/backend/vitest.config.ts`                 |
| `apps/web`      | Vitest       | `pnpm --filter web test`            | `apps/web/vitest.config.ts`                     |
| `apps/ai_agent` | pytest       | `cd apps/ai_agent && uv run pytest` | `[tool.pytest.ini_options]` in `pyproject.toml` |
| `contracts`     | `cargo test` | `cd contracts && cargo test`        | `contracts/Cargo.toml` workspace                |

Useful variants:

```bash
# Backend: watch mode, and coverage
pnpm --filter backend test:watch
pnpm --filter backend test:coverage

# Backend: a single file
pnpm --filter backend test -- rateLimiting.test.ts

# Contracts: one package rather than the whole workspace (this is what CI does)
cd contracts && cargo test -p token_transfer

# Backend tests plus the contract suite, as the Makefile defines "the tests"
make test
```

Conventions worth knowing:

- **Backend test files** live in `apps/backend/src/__tests__/` as `*.test.ts`, with a few
  co-located `*.spec.ts` files next to the module they cover (for example
  `src/socket/dispatcher.spec.ts`). Both are collected — the Vitest `include` is
  `src/**/*.{test,spec}.ts`.
- **`dist/` is excluded on purpose.** `pnpm build` emits a compiled copy of every spec, and
  without the exclusion every test would run a second time against stale output.
- **Web test files** are co-located with the code (`src/lib/x3dh.test.ts`). The web `include`
  is `src/**/*.test.ts` only — a `.tsx` test file is not picked up, so a component test must
  be `.ts` or the include pattern has to be widened deliberately.
- **AI agent tests** live in `apps/ai_agent/tests/`, and coverage is on by default via
  `addopts`, so a bare `uv run pytest` already prints the coverage table.

---

## The Drizzle mocking pattern

Backend tests do not run SQL. They replace `../db/index.js` with an object shaped like the
Drizzle client and assert on what the route or service asked that client to do. Three
modules are normally mocked together:

```ts
vi.mock('../db/index.js', () => ({
  db: {
    query: {
      messages: { findFirst: mockFindMessage },
      conversationMembers: { findMany: mockFindMembers },
    },
    update: mockUpdate,
    delete: mockDelete,
  },
}));

// Column references become inert sentinels. The code under test passes them to
// eq()/and(), which are themselves mocked, so their only job is to be
// distinguishable in an assertion.
vi.mock('../db/schema.js', () => ({
  conversations: {},
  messages: { id: 'id', conversationId: 'conversationId', senderId: 'senderId' },
}));

// The operators become identity-ish stubs, so a test can assert on the shape a
// call site built rather than on generated SQL.
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  desc: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
}));
```

`vi.mock` calls are hoisted, but the mock factories close over `vi.fn()` handles declared
above them, so the module under test is imported **after** the mocks with a top-level
dynamic import:

```ts
const { messagesRouter } = await import('../routes/messages.js');
```

A static `import` at the top of the file would bind the real `db` before the mocks are
installed. Every backend suite that mocks the database uses the `await import(...)` form;
follow it.

Builder chains are stubbed by returning the next link:

```ts
const returning = vi.fn().mockResolvedValue([{ id, createdAt }]);
const values = vi.fn().mockReturnValue({ returning });
mockInsert.mockReturnValue({ values });
```

### Why `.values()` sometimes has to be both thenable and expose `.returning()`

Drizzle's insert builder is a thenable. `db.insert(t).values(rows)` is itself awaitable and
executes the statement, _and_ `.returning()` can be chained onto it to execute the statement
and get the inserted rows back. Both forms are used in this codebase, sometimes inside the
same transaction: the message insert needs the generated `id` and `createdAt` so it calls
`.returning()`, while the envelope batch insert only cares that the rows landed and just
awaits `.values(...)`.

A stub that returns `{ returning }` alone makes the awaited call resolve to a plain object
and silently record nothing — the test passes while asserting on an insert that never
happened. A stub that returns only a promise makes `.returning()` throw
`is not a function`. So a shared insert stub has to satisfy both shapes:

```ts
function insertStub(table: string) {
  return {
    values: (vals: unknown) => ({
      returning: async () => recordInsert(table, vals),
      then: (resolve: (value: unknown) => void) => resolve(recordInsert(table, vals)),
    }),
  };
}
```

`apps/backend/src/__tests__/e2ee.integration.test.ts` is the canonical version. The `then`
property is what makes the returned object a thenable, so `await` resolves it and the call
is recorded either way. Two cautions:

- **Do not add `then` to a stub whose call sites never await the builder directly.** A
  thenable is awaited implicitly whenever it is returned from an `async` function, which can
  fire the recording side effect a second time. Add it only for the chains that need it.
- **If both forms run against the same stub, make the recorder idempotent** — or assert on
  call counts you have actually verified, rather than assuming one insert equals one
  recorded row.

When a test needs a transaction, mock `db.transaction` as a function that invokes its
callback with an object exposing the same stubbed builders:

```ts
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({ insert: insertStub }),
);
```

---

## Socket handlers are exercised through `dispatch`, never through a raw listener

Every client-to-server socket event goes through a single enveloped `dispatch` event
(`apps/backend/src/socket/dispatcher.ts`). `dispatcher.register(type, handler)` stores the
handler in a map; `listen()` attaches exactly one `socket.on('dispatch', ...)` listener,
which checks that the socket is authenticated, validates the envelope against
`EventEnvelopeSchema`, discards unknown event types, and applies `eventId` idempotency
before the handler is reached.

**There is no raw `socket.on(type, ...)` fallback.** A test that reaches into the emitter
looking for a listener registered for `'send_message'` will find nothing — and a test
written that way against an older revision passes while bypassing envelope validation,
idempotency, and the auth gate, which is precisely the surface those checks exist to
protect.

Drive handlers by emitting a well-formed envelope on `dispatch`:

```ts
let envelopeSeq = 0;

function dispatchEvent(socket: EventEmitter, type: string) {
  return async (payload: unknown) => {
    envelopeSeq += 1;
    // EventEmitter.prototype.emit.call bypasses any emit override on the fake
    // socket, so this delivers to the listener instead of being captured as an
    // outbound server -> client emit.
    EventEmitter.prototype.emit.call(socket, 'dispatch', {
      eventId: `test-evt-${envelopeSeq}`,
      type,
      timestamp: Date.now(),
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
```

Points to preserve when copying this:

- **`eventId` must be unique per emit.** Replay protection is scoped to the sending device
  and keyed by `eventId`, so a reused value turns the second and later events into no-ops and
  produces a confusing "the handler never ran" failure. Note that the check _fails open_ when
  Redis is `null`: a suite that mocks Redis away will not catch a duplicate `eventId`, and the
  same test starts failing the moment someone gives it an `ioredis-mock` instance. Generate a
  fresh id every time regardless.
- **`timestamp` must be current.** The envelope is rejected as stale before the handler runs,
  so use `Date.now()` rather than a frozen constant — and if the test uses
  `vi.useFakeTimers()`, keep the envelope timestamp inside the accepted window.
- **The dispatch listener is `async`.** `emit` returns synchronously, before the handler has
  finished, so await a tick — the `setTimeout` above — before asserting.
- **Set `socket.auth` first.** An unauthenticated socket gets an `error` envelope back and
  the handler is never reached.
- **Register handlers through the real registrar** (`registerMessagingHandlers(io, socket)`)
  rather than pulling a handler function out of the module, so whatever the registrar
  installs stays in the path.

Worked examples: `apps/backend/src/__tests__/dispatcher.test.ts` (envelope validation and
idempotency) and `apps/backend/src/__tests__/askAssistant.test.ts` (a handler driven through
`dispatch`).

---

## Trap: shared in-process counters leak between tests

Several modules keep module-level state that survives across tests within a Vitest worker,
and `vi.clearAllMocks()` does not touch it. Rate limiting is the one that bites most often.

`services/rateLimiter.ts` keeps a `localCounters` map used whenever Redis is unavailable —
which, in a suite that mocks `redis` to `null`, is always. The map is keyed by bucket,
window, and subject, and the window comes from wall-clock time, so several tests in the same
file hitting the same endpoint as the same subject are all charged against **one** budget.
The symptom is a test that passes alone and returns `429` when the file runs in order, or a
failure that moves when you reorder the file.

Reset explicitly in `beforeEach`:

```ts
const { resetRateLimitBucket, clearLocalRateLimitCounters } =
  await import('../services/rateLimiter.js');

beforeEach(async () => {
  vi.clearAllMocks();
  clearLocalRateLimitCounters(); // drops the process-local fallback map
  await resetRateLimitBucket('auth_challenge'); // drops the bucket's Redis keys too
  await resetRateLimitBucket('auth_verify');
  await resetRateLimitBucket('global_ip');
});
```

`clearLocalRateLimitCounters()` clears only the in-process map.
`resetRateLimitBucket(bucket)` clears the matching local keys _and_ scans and deletes the
bucket's keys in Redis (real or `ioredis-mock`). When a suite shares one `ioredis-mock`
instance, `await sharedRedis.flushall()` in `beforeEach` is the blunter equivalent for the
Redis half.

The same shape of leak exists elsewhere. Each affected module exports its own reset hook —
use it rather than reaching into the module:

| Module                      | State it keeps                                                   | Reset                                                           |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `services/rateLimiter.ts`   | Fallback counters plus Redis buckets                             | `clearLocalRateLimitCounters()`, `resetRateLimitBucket(bucket)` |
| `services/rateLimit.ts`     | Socket repeat-violation counts                                   | Cleared alongside the buckets the socket path charges           |
| Prekey low-watermark alerts | One-shot latches, so a second low-prekey event does not re-alert | `__resetPrekeyLowLatches()`                                     |
| Presence                    | Offline-broadcast dedupe set                                     | `__resetOfflineBroadcastsForTesting()`                          |

The general rule: **if a module keeps state outside a function so that production behaves
correctly across requests, it needs a test-visible reset, and every suite that touches it
must call that reset in `beforeEach`.** When you add such state, export the reset in the
same commit.

---

## General conventions

- **Assert on behaviour, not on generated SQL.** With `drizzle-orm` mocked there is no SQL to
  assert on. Check the status code, the response body, what was emitted to which room, and
  which rows were handed to `insert`/`update`.
- **Prefer `supertest` against a small Express app** built from the router under test
  (`app.use('/messages', messagesRouter)`) over importing the whole `app.ts`, unless the test
  is specifically about middleware ordering.
- **Mock `../middleware/auth.js` to inject `req.auth`** rather than minting real JWTs, in
  tests that are not themselves about authentication. Auth tests use the real middleware.
- **Never weaken a ciphertext or key invariant to make a test pass.** The guards in
  `apps/backend/src/__tests__/security.regression.test.ts` have a dedicated CI job; if a
  change trips them, the change is wrong, not the test. See the
  [threat model](threat-model.md) for what those invariants protect.
- **Keep tests deterministic.** No real timers over real durations, no network, no randomness
  that is not seeded. Use `vi.useFakeTimers()` for time-dependent logic, and the Soroban
  virtual ledger clock for contract expiry.
- **Formatting and lint apply to tests.** `pnpm --filter backend format:check` and
  `pnpm --filter backend lint` cover `src/`, which includes `__tests__/`.

---

## Related documents

- [Contract testing guide](../contracts/docs/testing.md) — the Soroban `Env` harness, auth
  mocking, and cross-contract test setup.
- [Database migration workflow](../apps/backend/docs/migrations.md) — why the suite never
  runs migrations, and how migrations are validated instead.
- [Threat model](threat-model.md) — the invariants the security regression tests defend.
- [Rate limits](security/rate-limits.md) — every bucket and its threshold, which is what the
  rate-limit tests assert against.
