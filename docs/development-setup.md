# Local Development Setup

This guide walks through setting up **clicked** — the Next.js web app, the Express/Socket.IO
backend, the Python AI agent, and the Soroban smart contracts — from a clean clone to a running
app on your machine.

## 1. Prerequisites

Install the exact versions below. Where the repo pins a version (via config files, not just a
README), that pin is called out.

| Tool | Version | Where it's pinned |
|---|---|---|
| Node.js | **20.x** | `.github/workflows/backend-ci.yml`, `frontend-ci.yml`, `security-ci.yml` all set up Node 20; the root `package.json` targets pnpm 10 which requires modern Node. (One legacy workflow, `pr.yml`, still uses Node 18 — treat 20 as the source of truth for local dev.) |
| pnpm | **10.28.1** | Root `package.json` → `"packageManager": "pnpm@10.28.1+sha512..."`. Run `corepack enable` so the pinned version is used automatically. |
| Rust (stable) + `wasm32-unknown-unknown` target | stable channel, with `wasm32-unknown-unknown`, `clippy`, `rustfmt` | `contracts/rust-toolchain.toml`. `rustup` will auto-install the right toolchain/target the first time you build inside `contracts/`. |
| uv (Python package manager) | any recent uv; manages **Python 3.12** | `apps/ai_agent/pyproject.toml` (`requires-python = ">=3.12"`) and `apps/ai_agent/.python-version` (`3.12`). |
| Docker + Docker Compose | recent Docker Desktop / Engine with Compose v2 | Used to run `infra/docker-compose.yml`. |
| Stellar CLI | optional | Only needed if you're deploying/invoking Soroban contracts against a live network (see `contracts/docs/api-deployment-invocation.md`). Not required to build, test, or run the web/backend apps. |

## 2. Clone and install JS/TS dependencies

```bash
git clone https://github.com/codebestia/clicked.git
cd clicked
corepack enable          # ensures the pinned pnpm 10.28.1 is used
pnpm install
```

This installs dependencies for every workspace declared in `pnpm-workspace.yaml`:
`apps/*` (`ai_agent`, `backend`, `tests`, `web`) and `contracts`.

## 3. Configure environment variables

There is one root-level env file, used primarily by the backend:

```bash
cp .env.example .env
```

Fill in at minimum, to get a working local backend:

- `JWT_SECRET` — any non-empty string for local dev.
- `DATABASE_URL` — e.g. `postgres://postgres:password@localhost:5432/clicked` (matches the
  `postgres` service below).
- `REDIS_URL` — e.g. `redis://localhost:6379`.
- `OBJECT_STORE_*` — the defaults already in `.env.example` (`OBJECT_STORE_ENDPOINT=http://localhost:9000`,
  bucket `clicked`, access key `clicked`, secret key `clickedsecret`) match the `minio`/`minio-init`
  services below out of the box — you generally don't need to change these for local dev.
- `RPC_URL`, `TOKEN_TRANSFER_CONTRACT_ID`, `GROUP_TREASURY_CONTRACT_ID`, `PROPOSALS_CONTRACT_ID` —
  only needed if you're exercising the blockchain/contract-linked features; leave blank otherwise.
- `OPENAI_API_KEY` — needed to run the AI agent for real; the AI agent's own test suite stubs it
  out (see §6).

Everything else in `.env.example` (TLS/pinning, rate limits, push/VAPID, XMTP, prekeys) has sane
defaults or is optional for local dev — see the inline comments in `.env.example` and
`docs/security/` for what each does.

## 4. Start infrastructure with Docker Compose

```bash
docker compose -f infra/docker-compose.yml up -d
```

This brings up four services (all with healthchecks so dependents can gate on readiness):

- **`postgres`** — `postgres:15-alpine`, exposed on `localhost:5432`, user `postgres` / password
  `password` / database `clicked`. Data persists in the `postgres_data` volume.
- **`redis`** — `redis:7-alpine`, exposed on `localhost:6379`. Data persists in `redis_data`.
- **`minio`** — S3-compatible object storage (`minio/minio`), exposed on `9000` (S3 API) and
  `9001` (web console). Root credentials are `clicked` / `clickedsecret`. This is what
  `OBJECT_STORE_*` in `.env` points at locally; swap those env vars to target real AWS S3 or
  Cloudflare R2 in production — the backend uses the same S3 client path either way.
- **`minio-init`** — a one-shot `minio/mc` container that waits for `minio` to be healthy, then
  creates the `clicked` bucket (`mc mb --ignore-existing`) and locks it down to no anonymous
  access (`mc anonymous set none`). It's idempotent and exits after running — expect it to show as
  "Exited (0)" in `docker ps`, not "running".

You can confirm everything is healthy with `docker compose -f infra/docker-compose.yml ps`.

## 5. Run database migrations

The backend uses Drizzle ORM (`apps/backend/drizzle.config.ts`, dialect `postgresql`). With
Postgres up and `DATABASE_URL` set in `.env` (loaded via `dotenv`), run:

```bash
pnpm --filter backend db:migrate
```

(This is also exposed as `make migrate`.) Other Drizzle commands available under
`apps/backend`: `db:generate` (generate migrations from schema changes), `db:push` (push schema
directly, no migration files), `db:studio` (Drizzle Studio UI).

## 6. Bring up the apps

### Everything at once

```bash
pnpm dev
```

This runs `turbo run dev`, which fans out to every workspace's own `dev` script (currently `web`
and `backend`; `dev` is marked `persistent`/uncached in `turbo.json`).

`make dev` does the same thing, but also starts Docker Compose first:

```bash
make dev   # = docker compose -f infra/docker-compose.yml up -d && pnpm dev
```

### Individually

```bash
# Frontend (Next.js) — http://localhost:3000
pnpm --filter web dev
# or: scripts/start-web.sh — a thin wrapper that cd's into apps/web and runs `pnpm run dev`
bash scripts/start-web.sh

# Backend (Express + Socket.IO), tsx watch mode
pnpm --filter backend dev

# AI agent (FastAPI), from apps/ai_agent
cd apps/ai_agent
uv run fastapi dev main.py
```

## 7. Smart contracts (Soroban / Rust)

The `contracts` workspace (`contracts/Cargo.toml`) is a separate Cargo workspace, not part of the
pnpm workspace. `contracts/rust-toolchain.toml` pins `channel = "stable"` with the
`wasm32-unknown-unknown` target and the `clippy`/`rustfmt` components — `rustup` will install
these automatically the first time you build there.

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test
```

To build and deploy the individual contracts (token transfer, group treasury, proposals) against a
configured network, see `contracts/scripts/deploy_*.sh` and `contracts/docs/api-deployment-invocation.md`,
or run all of them via:

```bash
make deploy-contracts
```

## 8. Running tests

| Command | What it runs |
|---|---|
| `pnpm test` | Whatever `test` scripts Turbo finds across JS/TS workspaces. |
| `pnpm --filter backend test` | Backend Vitest suite (`vitest run`). |
| `pnpm --filter web test` | Web Vitest suite. |
| `make test` | `pnpm --filter backend test` **and** `cd contracts && cargo test`. |
| `cd apps/ai_agent && uv run pytest` | AI agent's pytest suite (config lives in `pyproject.toml`: `testpaths = ["tests"]`, coverage on by default). |

### What needs Docker, and what doesn't

**The backend unit test suite does not require Docker, Postgres, Redis, or MinIO to be running.**
`apps/backend/src/__tests__/setup.ts` only sets fake env vars (`DATABASE_URL=postgres://localhost/test`,
etc.) — it never opens a real connection. Individual test files back that up with `vi.mock(...)`
for `../db/index.js`, `../lib/redis.js`, S3 clients, and friends (see e.g.
`apps/backend/src/__tests__/devices.revoke.test.ts`). CI (`.github/workflows/backend-ci.yml`) does
spin up real Postgres/Redis/MinIO service containers and runs migrations before testing, but that's
so `pnpm lint`/`format:check`/build-adjacent steps and any integration-style tests have something to
talk to — the unit tests themselves are written to be mockable and don't require it.

Similarly, the AI agent's tests (`apps/ai_agent/tests/conftest.py`) auto-patch `OPENAI_API_KEY`
and provide `mocker.patch(...)` fixtures for the OpenAI and Weaviate clients, so `uv run pytest`
runs without a real OpenAI key or a running Weaviate instance.

**You do need Docker Compose running for:**

- Actually using the app end-to-end (`pnpm dev` / `make dev`) — the backend will fail to boot
  without a reachable Postgres and Redis.
- Running `db:migrate` / `db:push` / `db:studio` against a real database.
- Exercising file upload / object storage flows manually.
- Any ad-hoc integration test that intentionally hits a live service instead of a mock.

## 9. Troubleshooting

- **Backend fails to start with a Postgres/Redis connection error.** Confirm
  `docker compose -f infra/docker-compose.yml ps` shows `postgres` and `redis` as healthy, and that
  `DATABASE_URL`/`REDIS_URL` in `.env` match the compose file's exposed ports/credentials
  (`postgres:password@localhost:5432/clicked`, `localhost:6379`).
- **`db:migrate` fails / tables missing.** Make sure Postgres is up and healthy *before* migrating
  — `minio-init` and the migration step both depend on their upstream service's healthcheck for a
  reason. Re-run `pnpm --filter backend db:migrate` after `docker compose ... up -d` reports the
  `postgres` container healthy.
- **File uploads / S3 calls fail locally.** Check that `minio-init` actually completed (it exits
  after creating the bucket — `docker compose -f infra/docker-compose.yml ps` should show it
  `Exited (0)`, not stuck restarting) and that the `OBJECT_STORE_*` vars in `.env` match the MinIO
  root credentials (`clicked` / `clickedsecret`) and endpoint (`http://localhost:9000`).
- **`pnpm install` picks the wrong pnpm version / lockfile mismatch.** Run `corepack enable` so the
  `packageManager` pin in `package.json` (`pnpm@10.28.1`) is honored; avoid a globally-installed
  pnpm of a different major version.
- **Rust build fails looking for the wasm target.** `rustup` should auto-install it from
  `contracts/rust-toolchain.toml` on first `cargo build`/`cargo test` inside `contracts/`. If it
  doesn't, run `rustup component add rust-std --target wasm32-unknown-unknown` explicitly (this is
  also called out for Windows in `contracts/docs/api-deployment-invocation.md`).
- **AI agent 500s with an OpenAI auth error.** You need a real `OPENAI_API_KEY` in your environment
  to use the agent live; the test suite doesn't need one since `conftest.py` stubs it and the
  client.

There is no dedicated `docs/troubleshooting.md` in this repo yet — for backend-specific runbooks
and deeper operational detail, see `docs/runbook.md` and `docs/observability.md`.

## 10. Further reading

- [`docs/runbook.md`](./runbook.md) — operational runbook.
- [`docs/observability.md`](./observability.md) — logging/metrics.
- [`docs/signal-integration.md`](./signal-integration.md), [`docs/group-epoch-sync.md`](./group-epoch-sync.md), [`docs/threat-model.md`](./threat-model.md) — protocol/security design docs.
- [`docs/security/`](./security) — TLS/pinning and rate-limit policy referenced from `.env.example`.
- [`apps/backend/docs/api-devices.md`](../apps/backend/docs/api-devices.md) and
  [`apps/backend/docs/e2ee-onboarding.md`](../apps/backend/docs/e2ee-onboarding.md) — backend API
  docs linked from the root `README.md`.
- [`contracts/docs/api-deployment-invocation.md`](../contracts/docs/api-deployment-invocation.md) —
  full contract build/deploy/invoke walkthrough.
