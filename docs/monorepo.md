# Monorepo Guide

This is the top-level, cross-cutting guide to how this repository is organized and tooled.
Each app also has its own `docs/` subfolder (`apps/web/docs`, `apps/backend/docs`,
`apps/ai_agent/docs`, `contracts/docs`) for app-specific documentation — this file only
covers the workspace layout and shared tooling that spans all of them.

## Repository layout (one level deep)

```
.
├── .github/          CI workflows / GitHub configuration
├── apps/             pnpm workspace packages (see below)
├── contracts/        Rust/Cargo workspace — Soroban smart contracts for Stellar
├── docs/             top-level docs (architecture, runbooks, security, this file)
├── infra/            local infrastructure — infra/docker-compose.yml (Postgres, Redis)
├── scripts/          repo-wide scripts (load testing, crypto-dep auditing, dev helpers)
├── src/              shared/top-level components (src/components/ui)
├── Makefile          convenience targets that wrap pnpm/turbo/cargo commands
├── package.json       root scripts + pinned shared devDependencies (turbo, prettier, ...)
├── pnpm-workspace.yaml defines the pnpm workspace package globs
└── turbo.json         Turborepo task graph (build/dev/lint)
```

### `apps/` (one level deeper)

| Directory | Purpose |
|---|---|
| `apps/web` | Next.js 16 / React 19 frontend. Own `package.json`, `eslint.config.mjs`, `vitest.config.ts`. |
| `apps/backend` | Node/TypeScript backend. Drizzle ORM, own `eslint.config.js`, tested with vitest. |
| `apps/ai_agent` | Next-gen AI agent app, written in Python (`pyproject.toml` / `uv.lock`) — not a pnpm package. |
| `apps/tests` | Top-level test suite directory (e.g. `apps/tests/routes/conversations.test.js`) sitting outside the individual app packages. |

## Root scripts vs. per-app scripts

Run a **root script** when you want the action to apply across the whole workspace, orchestrated by Turborepo:

- `pnpm dev` — `turbo run dev`, starts every app's dev process.
- `pnpm build` — `turbo run build`, builds every app in dependency order.
- `pnpm lint` — `turbo run lint`, lints every app.

Use `pnpm --filter <app> <script>` when working on a single app (faster inner loop, no need to
spin up/build unrelated apps), e.g. `pnpm --filter backend db:migrate` or `pnpm --filter web dev`.
The Makefile's `migrate` target is an example of this: `pnpm --filter backend db:migrate`.

`apps/ai_agent` (Python) and `contracts` (Rust) are outside the pnpm/turbo graph entirely — they're
driven with their own native tooling (`uv`, `cargo`), not `pnpm --filter`.

## Turborepo task graph

Defined in `turbo.json`:

- **`build`** — `dependsOn: ["^build"]`, meaning a package's `build` task only runs after the
  `build` tasks of all packages it depends on have completed (build dependencies first). Outputs
  `.next/**` (excluding `.next/cache/**`) and `dist/**` are cached by Turborepo — if inputs haven't
  changed, a cached result is replayed instead of rebuilding.
- **`dev`** — `cache: false`, `persistent: true`. Dev servers are long-running processes, so they
  are never cached and are marked persistent so Turbo knows not to wait for them to exit.
- **`lint`** — `dependsOn: ["^lint"]`, same upstream-first ordering as `build`, but lint output
  isn't declared as cacheable output in this config.

In short: `build` and `lint` respect the dependency graph and `build` is content-cached; `dev`
always runs fresh and never exits.

## Shared root tooling

- **Prettier**: `pnpm format` (`prettier --write "**/*.{ts,tsx,md,json}"`) and `pnpm format:check`
  (`prettier --check`, same glob) apply formatting across the entire workspace, driven by the
  shared root `.prettierrc.json` and `.prettierignore`. The root `package.json` pins
  `"prettier": "3.9.1"` exactly (no `^`/`~`), so every app formats with the identical Prettier
  version regardless of how pnpm hoists dependencies — no per-app Prettier version drift.
- **ESLint**: there is **no root ESLint config**. Each app configures its own linting
  independently (`apps/web/eslint.config.mjs`, `apps/backend/eslint.config.js`), unlike Prettier
  which is centralized.

## Why `contracts` is listed in the pnpm workspace

`pnpm-workspace.yaml` lists `contracts` as a package glob alongside `apps/*`, but `contracts/`
is a Cargo workspace (Soroban smart contracts for Stellar), not a JS/TS package — there is no
`package.json` anywhere under `contracts/`. As a result it contributes no package to the actual
pnpm workspace (pnpm only picks up directories that contain a `package.json`) and it does not
appear in the Turborepo task graph — `turbo run build`/`lint` never touch it.

In practice `contracts` is built, tested, and deployed independently through its own Rust
tooling, orchestrated from the root `Makefile`:

- `make test` runs `pnpm --filter backend test` for JS/TS **and separately** `cd contracts && cargo test` for the Soroban contracts.
- `make deploy-contracts` runs the shell scripts in `contracts/scripts/` (`deploy_token_transfer.sh`, `deploy_group_treasury.sh`) directly.
- `make lint` only runs `pnpm lint` (Turbo) — contract linting isn't wired into that target.

So the `contracts` entry in `pnpm-workspace.yaml` doesn't wire Cargo into the pnpm/Turbo graph;
it appears to be present for repo-organization / tooling-recognition purposes (e.g. so pnpm
doesn't need a separate exclusion and so editors/tools resolve `contracts` as a recognized
workspace root), while all real build/test/lint/deploy orchestration for it happens through
Cargo and the Makefile, not through `pnpm`/`turbo`.
