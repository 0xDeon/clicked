# Contract build, deployment & invocation guide

A practical, end-to-end guide for **building**, **deploying**, and **invoking** the three Soroban contracts in this repository using the tooling this repo actually uses:

| Contract | Path | Purpose |
|---|---|---|
| `token_transfer` | `contracts/contracts/token_transfer` | SEP-41 token transfer router (transfer/balance/upgrade) |
| `group_treasury` | `contracts/contracts/group_treasury` | Multi-sig treasury: deposits, member-managed withdraw proposals, voting |
| `proposals` | `contracts/contracts/proposals` | Community-funding proposals: create → vote → finalize → execute |

It also documents how a deployed contract ID reaches the frontend (`apps/web/src/lib/soroban.ts`) and the backend (`apps/backend`).

---

## 1. Tooling & prerequisites

The repo pins its Rust toolchain in [`contracts/rust-toolchain.toml`](../rust-toolchain.toml):

- `channel = "stable"`, with the `wasm32-unknown-unknown` target and the `clippy` + `rustfmt` components.
- `soroban-sdk = "22.0.0"` is pinned as the workspace dependency in [`contracts/Cargo.toml`](../Cargo.toml).

For deployment this repo uses the **Stellar CLI** (`stellar`) — the successor to the `soroban` CLI. The deploy scripts in [`contracts/scripts/`](../scripts) are written against it (`stellar contract upload|deploy|invoke`). Install instructions: <https://developers.stellar.org/docs/tools/cli/stellar-cli>.

Check the environment before starting:

```bash
# Rust toolchain (from the contracts workspace root)
rustup show
cargo --version

# Stellar CLI
stellar --version
```

---

## 2. Building the contracts (verified)

All commands run from `contracts/` (the Cargo workspace root). To build all three contracts for the Soroban wasm target:

```bash
cargo build --target wasm32-unknown-unknown --release
```

To build a single contract (the form the deploy scripts and CI use):

```bash
cargo build -p token_transfer  --target wasm32-unknown-unknown --release
cargo build -p group_treasury  --target wasm32-unknown-unknown --release
cargo build -p proposals       --target wasm32-unknown-unknown --release
```

**Verification.** These commands were run against the current `main` and complete successfully. The release wasm binaries land in `target/wasm32-unknown-unknown/release/`:

| Binary | Size |
|---|---|
| `token_transfer.wasm` | ~10 KB |
| `group_treasury.wasm` | ~32 KB |
| `proposals.wasm` | ~26 KB |

CI runs the same commands in `.github/workflows/contracts-ci.yml` (matrix over the three packages, ubuntu-latest).

> **Windows note.** `cargo build` requires a working `wasm32-unknown-unknown` rust-std for the active toolchain (`rustup component add rust-std --target wasm32-unknown-unknown`). The local build was verified with a stable GNU toolchain that had the target installed.

---

## 3. Testing the contracts (verified)

Run the in-repo unit tests per contract (the same command CI uses):

```bash
cargo test -p token_transfer
cargo test -p group_treasury
cargo test -p proposals
```

or all at once:

```bash
cargo test --workspace
```

**Verification.** These commands were run against current `main`:

- `cargo test -p token_transfer` — **8 passed / 0 failed**
- `cargo test -p group_treasury` — **40 passed / 0 failed** (6 ignored)
- `cargo test -p proposals` — 20 tests (see Windows note)

> **Windows note.** On Windows with the GNU (mingw) toolchain, `cargo test -p proposals` can fail while **linking the native `group_treasury.dll`** build of the `group_treasury` dev-dependency with `ld: error: export ordinal too large`. This is a mingw-w64 linker limitation with soroban-sdk's cdylib symbol table, not a contract-code failure — the test code compiles cleanly and all tests pass on the Linux CI that this repo uses. If you hit it, run the tests under Linux/WSL or rely on the `contracts-ci` GitHub Action.

Also relevant, from the CI workflow:

```bash
# Formatting check
cargo fmt --all -- --check

# Lint (wasm32 target, zero warnings)
cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings -A dead_code -A clippy::too-many-arguments
```

---

## 4. Deploying to testnet

This section covers deployment to the **Stellar testnet** using the Stellar CLI. The repo provides ready-made deploy scripts (Section 4.4); Section 4.5 walks through the same steps manually so you understand what the scripts do.

### 4.1 Select the network

Every command below passes `--network testnet`, which is a pre-configured network in the Stellar CLI (testnet RPC `https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`). This matches the frontend's default RPC URL in `apps/web/src/lib/soroban.ts`.

To target a different network, add it explicitly:

```bash
stellar network add mynet --rpc-url <RPC_URL> --network-passphrase "<PASSPHRASE>"
stellar network use mynet   # or pass --network mynet per command
```

### 4.2 Identity & funding

Generate a named identity (keypair) and fund it with testnet friendbot XLM in one step:

```bash
stellar keys generate deployer --fund --network testnet
```

or, if you already have an identity:

```bash
stellar keys fund deployer --network testnet
```

For scripts that take a raw secret key, you can instead export it:

```bash
stellar keys generate deployer --fund --as-secret
# S...
```

Keep a note of the account's public key — it becomes the `admin` of the deployed contracts:

```bash
stellar keys public-key deployer
# G...
```

### 4.3 Get a SEP-41 token contract

`token_transfer` and `group_treasury` both route through a **SEP-41-compatible token contract**. The simplest way to get one on testnet is to deploy the built-in asset contract (SAC wrapper) for a testnet-issued classic asset:

```bash
stellar contract asset deploy \
  --asset USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP \
  --source deployer \
  --network testnet
```

The command prints the asset's contract ID (a `C...` string). Export it for later steps:

```bash
export TOKEN_CONTRACT_ID="C..."
```

### 4.4 Use the repo's deploy scripts (one-liner path)

Each contract has a bash script in `contracts/scripts/` that builds the wasm, uploads it, deploys the instance, and calls `initialize`. They are self-contained but require a few env vars:

| Script | Required env vars |
|---|---|
| `deploy_token_transfer.sh` | `DEPLOYER_SECRET` (secret key `S...`), `TOKEN_CONTRACT_ID` (from 4.3) |
| `deploy_group_treasury.sh` | `DEPLOYER_SECRET`, `TOKEN_CONTRACT_ID` (from 4.3) |
| `deploy_proposals.sh` | `DEPLOYER_SECRET`, `TREASURY_CONTRACT_ID` (deployed `group_treasury`), `MIN_VOTES` (approval threshold) |

Example:

```bash
cd contracts
DEPLOYER_SECRET=S... \
TOKEN_CONTRACT_ID=C... \
./scripts/deploy_token_transfer.sh
```

Each script prints the env var line to add to your `.env` on success, e.g.:

```bash
TOKEN_TRANSFER_CONTRACT_ID=C...
```

### 4.5 Manual deployment walkthrough

The scripts wrap these three Stellar CLI steps. Run them from `contracts/` after building (Section 2).

**Step 1 — upload the wasm** (installs the code on-ledger, returns its hash):

```bash
stellar contract upload \
  --source deployer \
  --network testnet \
  --wasm target/wasm32-unknown-unknown/release/token_transfer.wasm
# e.g. 6ddb28e0980f643bb97350f7e3bacb0ff1fe74d846c6d4f2c625e766210fbb5b
```

**Step 2 — deploy the contract instance** (instantiate from the uploaded hash):

```bash
stellar contract deploy \
  --source deployer \
  --network testnet \
  --wasm-hash 6ddb28e0... \
  --alias token-transfer
# returns the contract ID: C...
```

**Step 3 — initialize** (one-time constructor per contract):

```bash
stellar contract invoke \
  --id C... \
  --source deployer \
  --network testnet \
  -- initialize \
  --admin G... \
  --token_contract C...
```

> For repeatable deployments you can pass `--salt <32-byte-hex>` to `stellar contract deploy` to get a deterministic contract ID.

**`initialize` signatures per contract:**

| Contract | `initialize` args | Notes |
|---|---|---|
| `token_transfer` | `--admin <Address>` `--token_contract <Address>` | No auth required |
| `group_treasury` | `--admin <Address>` `--token <Address>` `--threshold <u32>` | `threshold` ≥ 1 |
| `proposals` | `--admin <Address>` | `admin.require_auth()` — the `--source` must be the admin |

Recommended deploy order:

1. token contract (Section 4.3) → `TOKEN_CONTRACT_ID`
2. `token_transfer` → `TOKEN_TRANSFER_CONTRACT_ID`
3. `group_treasury` → `GROUP_TREASURY_CONTRACT_ID`
4. `proposals` → `PROPOSALS_CONTRACT_ID`

---

## 5. Invoking the contracts

The Stellar CLI builds an argument parser from the deployed contract's schema. Everything after `--` is the function call:

```bash
stellar contract invoke --id <CONTRACT_ID> --source <account> --network testnet -- <fn> --arg <value>
```

Argument formats (`stellar` CLI):

- **Address** — identity name (`deployer`) or raw strkey (`G...` / `C...`)
- **i128 / u32 / u64** — bare numeric literal, e.g. `--amount 100`
- **bool** — `true` / `false`
- **Bytes / BytesN<32>** — hex string, e.g. `--memo 636861742d6d657373616765`
- **String / Symbol** — bare word or quoted string

Use `--send=no` to simulate a call (dry-run) without submitting a transaction:

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet --send=no -- balance --address G...
```

### 5.1 `token_transfer`

```bash
# Transfer 100 units of the configured token (the --source must be `from`)
stellar contract invoke --id $TOKEN_TRANSFER_CONTRACT_ID --source $ALICE \
  --network testnet -- transfer \
  --from $ALICE --to $BOB --amount 100 --memo 636861742d6d657373616765

# Read a balance (simulation, no transaction)
stellar contract invoke --id $TOKEN_TRANSFER_CONTRACT_ID --source $ALICE \
  --network testnet --send=no -- balance --address $ALICE

# Admin: point the router at a new token contract
stellar contract invoke --id $TOKEN_TRANSFER_CONTRACT_ID --source $ADMIN \
  --network testnet -- set_token_contract --new_token C...

# Admin: upgrade to new wasm (upload first, then pass its hash)
stellar contract invoke --id $TOKEN_TRANSFER_CONTRACT_ID --source $ADMIN \
  --network testnet -- upgrade --new_wasm_hash <64-hex-chars>
```

### 5.2 `group_treasury`

```bash
# Admin: manage members
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $ADMIN \
  --network testnet -- add_member --member $MEMBER

# Member: deposit tokens into the treasury (--source must be `from`)
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $MEMBER \
  --network testnet -- deposit --from $MEMBER --token $TOKEN_CONTRACT_ID --amount 1000

# Member: propose a withdraw (proposer auto-approves; ttl_ledgers ≈ seconds/5)
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $MEMBER \
  --network testnet -- propose_withdraw \
  --proposer $MEMBER --to $BOB --token $TOKEN_CONTRACT_ID --amount 500 --ttl_ledgers 17280

# Members: vote on proposal id 0
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $MEMBER2 \
  --network testnet -- approve_withdraw --approver $MEMBER2 --proposal_id 0
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $MEMBER3 \
  --network testnet -- reject_withdraw --rejecter $MEMBER3 --proposal_id 0

# Admin: direct withdraw (bypasses voting)
stellar contract invoke --id $GROUP_TREASURY_CONTRACT_ID --source $ADMIN \
  --network testnet -- withdraw --to $BOB --token $TOKEN_CONTRACT_ID --amount 100
```

### 5.3 `proposals`

```bash
# Create a proposal expiring at a unix timestamp
stellar contract invoke --id $PROPOSALS_CONTRACT_ID --source $ALICE \
  --network testnet -- create_proposal \
  --proposer $ALICE --description "fund a mural" --expires_at 1790000000 \
  --treasury $GROUP_TREASURY_CONTRACT_ID --token $TOKEN_CONTRACT_ID \
  --to $BOB --amount 100

# Vote (one vote per address per proposal)
stellar contract invoke --id $PROPOSALS_CONTRACT_ID --source $ALICE \
  --network testnet -- vote --voter $ALICE --proposal_id 0 --support true

# After expiry: finalize (yes > no ⇒ Passed, otherwise Rejected)
stellar contract invoke --id $PROPOSALS_CONTRACT_ID --source $ALICE \
  --network testnet -- finalize_proposal --proposal_id 0

# Execute a Passed proposal (flips status to Executed; emits event)
stellar contract invoke --id $PROPOSALS_CONTRACT_ID --source $ALICE \
  --network testnet -- execute_proposal --executor $ALICE --proposal_id 0

# Execute a withdraw from the linked treasury (caller must be a treasury member)
stellar contract invoke --id $PROPOSALS_CONTRACT_ID --source $TREASURY_MEMBER \
  --network testnet -- execute_withdraw --caller $TREASURY_MEMBER --proposal_id 0
```

---

## 6. How a deployed contract ID reaches the frontend & backend

Contract IDs are passed to the app entirely through environment variables. The deploy scripts print the exact lines to add (Section 4.4).

### 6.1 Backend (`.env`)

The root [`.env.example`](../../.env.example) declares, under `# Blockchain`:

```bash
RPC_URL=
TOKEN_TRANSFER_CONTRACT_ID=
GROUP_TREASURY_CONTRACT_ID=
PROPOSALS_CONTRACT_ID=
```

- **`TOKEN_TRANSFER_CONTRACT_ID`** is **required** for the backend to boot — it is validated by the zod schema in `apps/backend/src/config.ts` (`z.string().min(1)`).
- The **Stellar listener** (`apps/backend/src/index.ts`) is only started when `STELLAR_RPC_URL` **and** `TOKEN_TRANSFER_CONTRACT_ID` are set. When `GROUP_TREASURY_CONTRACT_ID` is also set, it additionally watches treasury events (`proposal_created`, `proposal_approved`, `proposal_rejected`, `proposal_executed`, `proposal_expired`). See `apps/backend/src/services/stellarListener.ts`.
- Note: the listener reads `STELLAR_RPC_URL` while `.env.example` documents `RPC_URL` — a naming drift to be aware of when configuring the listener.

### 6.2 Frontend (`NEXT_PUBLIC_*`)

The frontend's Soroban client, [`apps/web/src/lib/soroban.ts`](../../apps/web/src/lib/soroban.ts), resolves configuration at call time:

| Env var | Default if unset | Used for |
|---|---|---|
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC server |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `Networks.TESTNET` (stellar-sdk) | Network passphrase for building/signing |
| `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` | literal placeholder `REPLACE_WITH_TOKEN_TRANSFER_CONTRACT_ID` | Contract ID passed to `new Contract(CONTRACT_ID)` |

So the deployed `token_transfer` contract ID reaches the frontend like this:

```bash
# apps/web/.env.local (Next.js exposes NEXT_PUBLIC_* to the browser)
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT=C...
```

In code, `transferToken()` does `new Contract(process.env.NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT || 'REPLACE_WITH...')` and calls `contract.call('transfer', from, to, amount, memo)`, then simulates/signs/submits via Freighter (details in `apps/web/docs/api-soroban-client.md`).

**Precision notes on the wiring:**

- The **frontend prefix** (`NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT`) and the **backend variable** (`TOKEN_TRANSFER_CONTRACT_ID`) are **different variables** and are validated independently — the deploy scripts print the backend form, so you must add the `NEXT_PUBLIC_`-prefixed frontend form separately.
- If `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` is left unset, the frontend silently uses the placeholder string `REPLACE_WITH_TOKEN_TRANSFER_CONTRACT_ID`, so transfers fail at simulation rather than with a clear config error.
- The frontend currently only invokes `token_transfer.transfer`; `group_treasury` and `proposals` are consumed by the backend listener and the treasury REST API (`apps/backend/docs/api-treasury.md`).

---

## 7. Reference

- Deploy scripts: `contracts/scripts/deploy_token_transfer.sh`, `deploy_group_treasury.sh`, `deploy_proposals.sh`
- Contract sources: `contracts/contracts/{token_transfer,group_treasury,proposals}/src/lib.rs`
- API references: `contracts/docs/api-token-transfer.md`, `contracts/docs/api-proposals.md`
- CI: `.github/workflows/contracts-ci.yml` (build + test + clippy + audit)
- Frontend client: `apps/web/src/lib/soroban.ts` and `apps/web/docs/api-soroban-client.md`
- Backend listener: `apps/backend/src/index.ts`, `apps/backend/src/services/stellarListener.ts`, `apps/backend/src/config.ts`
- Stellar CLI manual: <https://developers.stellar.org/docs/tools/cli/stellar-cli>
- Stellar CLI invoke argument types: <https://developers.stellar.org/docs/tools/cli/cookbook/contract-invoke-arguments>
