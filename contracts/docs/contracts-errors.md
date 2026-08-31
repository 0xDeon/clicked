# Contract error and panic reference

Every failure condition across the three Soroban contracts — `token_transfer`, `group_treasury`, and `proposals` — grouped by function: what triggers it, what the caller observes, and how a client should present it.

This reflects the implementation on Soroban SDK 22.0.0, pinned in [contracts/Cargo.toml](../Cargo.toml).

## How failure works in these contracts

None of the three contracts define a `#[contracterror]` enum. **Every failure is a `panic!` with a string message, or a `.expect()` on a missing storage read.** This has direct consequences for callers:

- **There are no stable numeric error codes.** A panic in a Soroban contract traps the host and the invocation aborts; the panic string is a debug aid, not part of the ABI. In release builds it is generally not recoverable from the transaction result, and it must never be parsed programmatically.
- **Failures are all-or-nothing.** A trapped invocation reverts every storage write and discards every event published during that call. There are no partial applications and no cleanup to perform — see [Atomicity](#atomicity-and-state-on-failure).
- **Clients must map errors by context, not by message.** Because the string is unreliable at the boundary, the frontend has to infer the cause from what it *knows about the call it made* — the function invoked and the state it read beforehand. That is why the mapping guidance below is organised around pre-flight checks and simulation.

Failures fall into three kinds, distinguished throughout this document:

| Kind | Meaning | Typical client response |
| ---- | ------- | ----------------------- |
| **Authorization** | The caller is not permitted, or did not sign. `require_auth()` failures and membership checks. | Explain who *is* permitted. Never retry blindly. |
| **Validation** | The arguments are unacceptable in isolation — non-positive amounts, expiry in the past. | Fix client-side before submitting; these are preventable. |
| **State-machine** | The arguments are fine but the contract is not in a state that permits the action — voting twice, approving after expiry, executing an unfinalised proposal. | Re-read on-chain state and update the UI; the action may become valid later, or never. |

A fourth category, **initialization**, covers `.expect("not initialized")` reads. These indicate a deployment fault rather than a user error and should surface as a system error, not a user-facing validation message.

---

## `token_transfer`

Source: [contracts/contracts/token_transfer/src/lib.rs](../contracts/token_transfer/src/lib.rs). API reference: [api-token-transfer.md](api-token-transfer.md).

### `initialize(env, admin, token_contract)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `DataKey::Admin` already present in instance storage | State-machine | `already initialized` |

```rust
if env.storage().instance().has(&DataKey::Admin) {
    panic!("already initialized");
}
```

**Caller observes**: the invocation traps; no storage is written.

**Note there is no authorization on this function.** `initialize` calls no `require_auth()`, so on a freshly deployed, uninitialized contract *anyone* can call it and set themselves as admin. Deployment and initialization must therefore happen in the same atomic step — see [api-deployment-invocation.md](api-deployment-invocation.md). The `already initialized` guard is the only thing preventing a takeover after the fact.

**Client presentation**: this is an operator action, not a user action. Surface as "Contract is already initialized" in tooling; it should never reach an end user.

### `transfer(env, from, to, amount, memo)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `amount <= 0` | Validation | `amount must be positive` |
| `from` did not authorize the call | Authorization | host auth failure (no contract message) |
| `DataKey::TokenContract` unset | Initialization | `not initialized` |
| Underlying SEP-41 token rejects the transfer | Delegated | token contract's own failure |

Order matters: the amount check runs **before** `from.require_auth()`, so a non-positive amount fails without ever prompting the user to sign.

```rust
if amount <= 0 {
    panic!("amount must be positive");
}
from.require_auth();
```

The most common real-world failure is the last row: **insufficient balance is not checked by this contract at all.** `token_transfer` is a thin router; it calls `token.transfer(&from, &to, &amount)` and the SEP-41 token contract enforces balance. The failure therefore originates in a sub-invocation, and the panic message — if any is visible — belongs to the token contract, not this one.

**Client presentation**:

- `amount <= 0` — prevent entirely with client-side validation; never let it reach the chain.
- Auth failure — most often the user rejected the Freighter prompt. Present as a cancellation, not an error.
- Insufficient balance — check the balance before submitting and block the action with a clear message. If it still fails at submit time (balance changed between check and submit), present "Insufficient balance to complete this transfer".
- `not initialized` — system error; the deployment is broken.

### `balance(env, address)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `DataKey::TokenContract` unset | Initialization | `not initialized` |

Read-only, no authorization. Can also fail if the underlying token contract's `balance` call fails.

**Client presentation**: treat a failure here as "balance unavailable" and render a placeholder rather than `0` — showing zero for an unreadable balance is misleading.

### `token_contract(env)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `DataKey::TokenContract` unset | Initialization | `not initialized` |

Read-only, no authorization. Fails only on an uninitialized contract.

### `set_token_contract(env, new_token)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `DataKey::Admin` unset | Initialization | `not initialized` |
| Caller is not the admin | Authorization | host auth failure |

```rust
let admin: Address = env.storage().instance().get(&DataKey::Admin)
    .expect("not initialized");
admin.require_auth();
```

The admin is loaded from storage first, so an uninitialized contract fails with `not initialized` before any auth check.

**Client presentation**: admin-only tooling. Non-admin users should never see this function in the UI.

### `upgrade(env, new_wasm_hash)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `DataKey::Admin` unset | Initialization | `not initialized` |
| Caller is not the admin | Authorization | host auth failure |
| `new_wasm_hash` is not an installed wasm | Host | host failure from `update_current_contract_wasm` |

Same admin gate as `set_token_contract`. The third row is a host-level failure: the hash must correspond to wasm already installed on the network.

**Client presentation**: operator tooling only.

---

## `group_treasury`

Source: [contracts/contracts/group_treasury/src/lib.rs](../contracts/group_treasury/src/lib.rs).

Every admin-gated function routes through one helper, so the same two failures recur across all of them:

```rust
fn require_admin(env: &Env) -> Address {
    let admin: Address = env.storage().instance().get(&DataKey::Admin)
        .expect("not initialized");
    admin.require_auth();
    admin
}
```

### `initialize(env, admin, _token, threshold)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Already initialized | State-machine | `already initialized` |
| `threshold == 0` | Validation | `threshold must be at least 1` |

As with `token_transfer::initialize`, **there is no `require_auth()`** — initialization is a deployment-time race and must be atomic with deployment.

The `threshold` guard prevents a treasury where zero approvals suffice. Note it only enforces a lower bound: a `threshold` **greater than the eventual member count** is accepted, producing a treasury where no withdraw proposal can ever reach approval. Members are added after initialization, so the contract cannot validate this at init time. Operator tooling should check it.

**Client presentation**: operator error. "Approval threshold must be at least 1."

### `get_threshold(env)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Not initialized | Initialization | `not initialized` |

Read-only, no authorization.

### `add_member(env, member)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Not initialized | Initialization | `not initialized` |
| Caller is not the admin | Authorization | host auth failure |
| `member` is already in the members list | State-machine | `member already exists` |

**Client presentation**: check membership with `is_member` before offering the action, and present `member already exists` as "This address is already a member" rather than a failure.

### `remove_member(env, member)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Not initialized | Initialization | `not initialized` |
| Caller is not the admin | Authorization | host auth failure |
| `member` is not in the members list | State-machine | `member not found` |

**Removing a member does not clean up their votes.** `DataKey::Vote(id, member)` entries survive removal, so a removed member's existing approvals still count toward `approvals` on open proposals. Removal also shrinks `member_count`, which changes the `blocking_minority` calculation in `reject_withdraw` for every open proposal. Clients should re-read open proposals after any membership change rather than trusting cached tallies.

### `is_member(env, member)` / `get_members(env)`

No failure conditions. Both use `unwrap_or_else(|| Vec::new(&env))`, so they return `false` and an empty vector respectively on an uninitialized contract rather than panicking. **Neither can be used to detect an uninitialized treasury** — use `get_threshold` for that.

### `deposit(env, from, token, amount)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `amount <= 0` | Validation | `amount must be positive` |
| `from` did not authorize | Authorization | host auth failure |
| Token transfer into the treasury fails | Delegated | token contract's own failure |

The amount check precedes `from.require_auth()`, so an invalid amount fails before any signing prompt.

**Deposit is not member-gated** — any address may deposit into the treasury. This is deliberate.

As with `token_transfer::transfer`, the depositor's balance is enforced by the SEP-41 token contract, not here.

**Client presentation**: validate the amount client-side; present a token failure as "Insufficient balance".

### `withdraw(env, to, token, amount)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `amount <= 0` | Validation | `amount must be positive` |
| Not initialized | Initialization | `not initialized` |
| Caller is not the admin | Authorization | host auth failure |
| Tracked balance for `token` is less than `amount` | State-machine | `insufficient funds` |
| Token transfer out fails | Delegated | token contract's own failure |

Order is: amount check → `require_admin` → balance check → transfer.

**This is the admin bypass path.** `withdraw` is admin-only and does **not** consult the proposal system at all — no threshold, no approvals, no member vote. The multisig flow (`propose_withdraw` → `approve_withdraw`) is a separate mechanism, and this function is not gated by it. Note that `proposals::execute_withdraw` calls *this* function via the treasury interface, which means the `proposals` contract address must itself be the treasury admin for that path to work.

The `insufficient funds` check reads the contract's **internally tracked** `Balances` map, not the token contract's real balance. If tokens are transferred directly to the treasury address without going through `deposit`, the tracked balance understates reality and withdrawals will be refused despite the funds existing.

**Client presentation**: "Insufficient treasury balance" — and surface the tracked balance from `balance(token)` so the number the user sees matches the number the contract checks.

### `balance(env, token)`

No failure conditions. Returns `0` for an unknown token or an uninitialized contract via `unwrap_or(0)`.

**A zero return is ambiguous** — it may mean no funds, an unknown token, or an uninitialized treasury. Clients that need to distinguish these must call `get_threshold` to confirm initialization.

### `propose_withdraw(env, proposer, to, token, amount, ttl_ledgers)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `proposer` did not authorize | Authorization | host auth failure |
| `proposer` is not a member | Authorization | `proposer is not a member` |
| `amount <= 0` | Validation | `amount must be positive` |
| Tracked balance for `token` is less than `amount` | State-machine | `insufficient funds` |

Order: `require_auth` → membership → amount → balance. **The signing prompt appears before the membership check**, so a non-member is asked to sign a transaction that then fails. Check `is_member` client-side first to avoid this.

The balance check happens at *proposal* time. Funds are not escrowed, so a proposal that was fundable when created may be unfundable when executed.

`expires_at` is computed as `env.ledger().timestamp() + (ttl_ledgers as u64 * 5)` — an approximation of 5 seconds per ledger. It is a timestamp, not a ledger count, despite the parameter name.

**Client presentation**: gate the UI on `is_member`; validate amount and balance before submitting.

### `approve_withdraw(env, approver, proposal_id)` / `reject_withdraw(env, rejecter, proposal_id)`

Both delegate validation to one shared helper, so **their failure conditions are identical**:

```rust
fn require_votable(env: &Env, voter: &Address, proposal_id: u32) -> WithdrawProposal {
    voter.require_auth();

    if !Self::is_member(env.clone(), voter.clone()) {
        panic!("not a member");
    }

    let proposal: WithdrawProposal = env.storage().instance()
        .get(&DataKey::Proposal(proposal_id))
        .expect("proposal not found");

    if proposal.status != ProposalStatus::Active {
        panic!("proposal is not pending");
    }
    if proposal.status == ProposalStatus::Expired
        || env.ledger().timestamp() >= proposal.expires_at
    {
        panic!("proposal expired");
    }
    if env.storage().instance().has(&DataKey::Vote(proposal_id, voter.clone())) {
        panic!("already voted");
    }

    proposal
}
```

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Voter did not authorize | Authorization | host auth failure |
| Voter is not a member | Authorization | `not a member` |
| No proposal with `proposal_id` | State-machine | `proposal not found` |
| Proposal status is not `Active` | State-machine | `proposal is not pending` |
| Voting window has closed | State-machine | `proposal expired` |
| This address already voted | State-machine | `already voted` |
| Threshold read fails | Initialization | `not initialized` |

**A subtlety worth knowing when reading the messages.** The `status != Active` check runs before the expiry check, and `Expired` is not `Active`. So a proposal whose *status field* has been set to `Expired` fails with `proposal is not pending`, and the `status == Expired` half of the expiry condition is unreachable. `proposal expired` is only ever emitted for a proposal still marked `Active` whose `expires_at` has passed — the wall-clock case. Both mean "you cannot vote on this", so this does not change client behaviour; it matters only if you are matching messages during debugging.

Note also that **the proposer's auto-approval is recorded as a vote** at creation time (`approvals: 1` and a `Vote` entry). The proposer therefore gets `already voted` if they try to approve their own proposal, and cannot reject it either.

**Client presentation** — this is the richest mapping surface, and all six conditions are avoidable client-side:

| Condition | Message to show |
| --------- | --------------- |
| Not a member | "Only treasury members can vote on withdrawals." |
| Proposal not found | "This proposal no longer exists." |
| Not pending | "This proposal has already been resolved." Re-read and show the final status. |
| Expired | "The voting window for this proposal has closed." |
| Already voted | "You have already voted on this proposal." Show their recorded vote. |

Read the proposal with `get_proposal` and check `is_member` before rendering vote buttons; every one of these should be a disabled control with an explanation rather than a failed transaction.

### `get_proposal(env, proposal_id)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| No proposal with `proposal_id` | State-machine | `proposal not found` |

Read-only, no authorization.

### `list_proposals(env)` / `get_pending_proposals(env)`

No failure conditions; return an empty `Vec` when nothing matches.

**Both iterate `1..=count`, but ids are assigned starting at `0`.** Proposal `0` — the first proposal ever created — is therefore never returned by either function, while the loop's final iteration looks up a non-existent id. The `if let Some(...)` guard means this does not panic, but a client relying on these functions will silently miss the first proposal. Fetch by id with `get_proposal` when completeness matters.

---

## `proposals`

Source: [contracts/contracts/proposals/src/lib.rs](../contracts/proposals/src/lib.rs). API reference: [api-proposals.md](api-proposals.md). Lifecycle: [concepts-proposal-lifecycle.md](concepts-proposal-lifecycle.md).

All functions that take a `proposal_id` load it through one helper:

```rust
fn load_proposal(env: &Env, proposal_id: u64) -> Proposal {
    env.storage().instance().get(&DataKey::Proposal(proposal_id))
        .expect("proposal not found")
}
```

So **`proposal not found` is a possible failure of every id-taking function** in this contract and is not repeated in each table below.

### `initialize(env, admin)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Already initialized | State-machine | `already initialized` |
| `admin` did not authorize | Authorization | host auth failure |

Unlike the other two contracts, this `initialize` **does** call `admin.require_auth()` — after the already-initialized guard.

### `create_proposal(env, proposer, description, expires_at, treasury, token, to, amount)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `proposer` did not authorize | Authorization | host auth failure |
| `expires_at <= now` | Validation | `expires_at must be in the future` |
| `amount <= 0` | Validation | `amount must be positive` |

`expires_at` is a **unix timestamp in seconds**, compared against `env.ledger().timestamp()`. Passing a duration rather than an absolute timestamp is the classic mistake here and fails immediately.

There is no membership check — **anyone may create a proposal**. Membership is enforced later, at `execute_withdraw`.

**Client presentation**: both validation failures are fully preventable. Compute `expires_at` as an absolute timestamp with a safety margin, and validate the amount before submitting.

### `vote(env, voter, proposal_id, support)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `voter` did not authorize | Authorization | host auth failure |
| Proposal status is not `Active` | State-machine | `proposal is not active` |
| `now >= expires_at` | State-machine | `voting window has closed` |
| This address already voted | State-machine | `voter has already voted` |

```rust
let vote_key = DataKey::Vote(proposal_id, voter.clone());
if env.storage().instance().has(&vote_key) {
    panic!("voter has already voted");
}
```

**One vote per address per proposal, and votes cannot be changed** — there is no revoke or re-vote path. The stored value records the direction, and the mere presence of the key blocks any further vote.

There is no membership or token-weighting check: any address that can pay the fee may vote, and every vote counts equally.

The boundary is `now >= expires_at`, so voting is closed *at* the expiry timestamp, not one second after.

**Client presentation**:

| Condition | Message to show |
| --------- | --------------- |
| Not active | "Voting has closed on this proposal." Show the current status. |
| Window closed | "The voting period ended." Show the expiry time. |
| Already voted | "You have already voted." Show the recorded direction. |

Read `get_proposal` and check the vote key before rendering vote controls.

### `finalize_proposal(env, proposal_id)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Proposal status is not `Active` | State-machine | `proposal already finalized` |
| `now < expires_at` | State-machine | `cannot finalize before expiry` |

**Callable by anyone** — no `require_auth()`. This is deliberate: finalisation must not depend on a specific party being available.

Outcome mapping once it succeeds: `yes_votes > no_votes` → `Passed`; otherwise → `Rejected`. **A tie is a rejection**, and a proposal with zero votes is rejected.

**Client presentation**: expose finalisation only after `expires_at` has passed. `proposal already finalized` usually means someone else finalised first — treat it as success, re-read the proposal, and show the outcome rather than an error.

### `finalize_expired_proposal(env, proposal_id)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| Proposal status is not `Active` | State-machine | `proposal not Pending` |
| `now <= expires_at` | State-machine | `proposal not expired` |

An alternative terminal path that sets status to `Expired` instead of tallying votes. No authorization.

**Two ways to close the same proposal.** `finalize_proposal` and `finalize_expired_proposal` are both callable on the same `Active`, past-expiry proposal, and whichever lands first wins — the other then fails with its "already finalized" equivalent. `finalize_expired_proposal` discards the vote tally entirely, so **a proposal that would have `Passed` can be closed as `Expired` instead**, permanently blocking execution. Clients should call `finalize_proposal`; `finalize_expired_proposal` is for abandoning proposals.

The boundary differs by one: `finalize_proposal` requires `now >= expires_at`, while `finalize_expired_proposal` requires `now > expires_at`. Exactly at the expiry timestamp only `finalize_proposal` is callable.

**Client presentation**: `proposal not Pending` and `proposal not expired` both mean the same thing to a user — "this proposal cannot be closed right now". Re-read state and show the actual status.

### `execute_proposal(env, executor, proposal_id)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `executor` did not authorize | Authorization | host auth failure |
| Proposal status is not `Passed` | State-machine | `proposal is not in Passed state` |

**This is the canonical "executing an unfinalised proposal" failure.** A proposal that is still `Active` — even one with overwhelming support and a passed expiry — is not `Passed` until `finalize_proposal` has run. Attempting to execute it fails with `proposal is not in Passed state`. The same message covers `Rejected`, `Expired`, and already-`Executed` proposals, so the message alone does not tell the caller which case they hit.

Execution is otherwise unrestricted: any address may execute a `Passed` proposal.

This function only flips the status to `Executed` and emits an event. It moves no funds — that is `execute_withdraw`.

**Client presentation**: read the proposal and branch on the actual status rather than relying on the message.

| Actual status | Message to show |
| ------------- | --------------- |
| `Active`, past expiry | "This proposal must be finalised before it can be executed." Offer the finalise action. |
| `Active`, before expiry | "Voting is still open until <expiry>." |
| `Rejected` | "This proposal was rejected and cannot be executed." |
| `Expired` | "This proposal expired without being finalised." |
| `Executed` | "This proposal has already been executed." |

### `execute_withdraw(env, caller, proposal_id)`

The most failure-prone function in the codebase — it spans authorization, state-machine, and cross-contract failures.

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| `caller` did not authorize | Authorization | host auth failure |
| Status is `Executed` | State-machine | `proposal already executed` |
| Status is not `Passed` | State-machine | `proposal not approved` |
| `caller` is not a treasury member | Authorization | `caller is not a treasury member` |
| Treasury balance is less than `proposal.amount` | State-machine | `insufficient funds` |
| The treasury `withdraw` call fails | Delegated | `group_treasury` failure (see below) |

Checks run in that order, so the already-executed case is distinguished from the general not-approved case by its own message — the only place in these contracts where double-execution is called out specifically.

Membership is checked against the **treasury contract stored on the proposal**, via a cross-contract call:

```rust
let treasury_client = crate::treasury_interface::TreasuryClient::new(&env, &proposal.treasury);

if !treasury_client.is_member(&caller.clone()) {
    panic!("caller is not a treasury member");
}
```

Two failure sources are easy to miss:

- **The `treasury` address is fixed at proposal creation** and never validated. A proposal created with a wrong or non-existent treasury address fails at this cross-contract call, and the failure will look like a host error rather than a clean panic.
- **The final `treasury_client.withdraw(...)` is admin-gated inside `group_treasury`.** For this path to work, the `proposals` contract's own address must be the treasury's admin. If it is not, execution fails at the last step with an authorization failure from the *other* contract — after every check in this function has passed. This is the hardest failure here to diagnose from the client, and it is a deployment misconfiguration, not a user error.

Note the balance is checked here and again inside `group_treasury::withdraw`; both read the same tracked `Balances` map.

**Client presentation**:

| Condition | Message to show |
| --------- | --------------- |
| Already executed | "This withdrawal has already been executed." |
| Not approved | "This proposal has not been approved." Show the status. |
| Not a treasury member | "Only treasury members can execute this withdrawal." |
| Insufficient funds | "The treasury does not have enough funds." Show the tracked balance. |
| Treasury auth failure | System error: "This withdrawal cannot be completed. Contact an administrator." |

Gate the UI on `is_member` and the treasury balance before offering the action.

### `get_proposal(env, proposal_id)`

| Trigger | Kind | Message |
| ------- | ---- | ------- |
| No proposal with `proposal_id` | State-machine | `proposal not found` |

Read-only, no authorization.

---

## Atomicity and state on failure

A panic traps the invocation, and Soroban reverts the **entire transaction**. Therefore:

- **No storage write survives a failed call.** In `execute_withdraw`, a failure at the treasury withdraw step leaves the proposal `Passed`, not `Executed` — the status update is rolled back with everything else.
- **No event is emitted by a failed call.** Events published before the panic are discarded. A client watching the chain sees nothing at all for a failed invocation — absence of an event is the only signal.
- **Cross-contract effects roll back too.** A failure in `proposals::execute_withdraw` after the treasury transfer would revert the token movement as well.

The practical consequence for clients: **a failed transaction requires no compensating action.** Re-read state and retry if appropriate. Never attempt to "undo" a failed call.

---

## What a failure looks like from the frontend

The frontend path is [apps/web/src/lib/soroban.ts](../../apps/web/src/lib/soroban.ts), whose `transferToken` wraps `token_transfer::transfer`. Every failure surfaces as a thrown `Error`, and the **stage at which it throws is the most reliable signal of what went wrong** — far more reliable than the message text.

The five stages, in order:

**1. Wallet unavailable** — before any contract interaction:

```ts
const connectionStatus = await freighter.isConnected();
if (!connectionStatus.isConnected) {
  throw new Error('Freighter not installed or not connected');
}

const { address: publicKey, error: addressError } = await freighter.getAddress();
if (addressError || !publicKey) {
  throw new Error('Unable to read Freighter wallet address');
}
```

Not a contract error. Present as a wallet-connection prompt.

**2. Simulation failure** — where nearly all contract panics surface:

```ts
const simResult = await server.simulateTransaction(tx);
if (SorobanRpc.Api.isSimulationError(simResult)) {
  throw new Error(String(simResult.error));
}
```

**This is the important one.** Simulation executes the contract against current state without submitting, so `amount must be positive`, `not a member`, `already voted`, `proposal is not in Passed state`, and every other deterministic panic is caught here — before the user is ever asked to sign, and before any fee is paid.

`simResult.error` is the richest diagnostic available anywhere in the flow: it typically contains the host error and, in non-release builds, the panic string. **Log it in full.** Do not show it to users, and do not branch on its text — treat any match as a heuristic for diagnostics only.

**3. Signature failure** — user rejection:

```ts
if (signResult.error || !signResult.signedTxXdr) {
  throw new Error('Unable to sign transaction with Freighter');
}
```

Almost always the user declining the prompt. Present as a cancellation, not a failure.

**4. Submission failure**:

```ts
if (sendResult.status === 'ERROR') {
  throw new Error(`Transaction failed: ${String(sendResult.errorResult || sendResult)}`);
}
```

Usually a malformed transaction, a bad sequence number, or an insufficient fee — not a contract panic.

**5. Post-submission revert** — a contract failure that simulation did not predict:

```ts
if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
  throw new Error(`Transaction reverted: ${hash}`);
}
```

Reached when state changed between simulation and inclusion — the classic case being a balance spent by another transaction in the interim, or a proposal finalised by someone else. The message carries only the hash; the reason must be read from the transaction result on-chain.

**6. Confirmation timeout** — after 30 polls at 2s intervals (~60s):

```ts
throw new Error(`Transaction not confirmed after timeout: ${hash}`);
```

**Not a failure.** The transaction may still succeed. Never present this as an error or invite a retry — a retry risks a double transfer. Show it as pending, keep the hash, and reconcile later.

### Mapping strategy for `lib/soroban.ts` callers

Because panic strings are unreliable at the boundary, the durable approach has three parts:

**Pre-flight in the client.** Every validation failure and most state-machine failures are knowable before submitting. Read `get_proposal`, `is_member`, `balance`, and the vote key, and disable the action with an explanation instead of letting it fail. This is where the specific, useful messages in the per-function tables above belong — not in a catch block.

**Branch on the stage, not the string.** Simulation failure, signature failure, submission failure, revert, and timeout each warrant a different user-facing treatment regardless of which contract function was called:

```ts
try {
  const hash = await transferToken(recipient, amount, memo);
  // success
} catch (err) {
  // Distinguish by stage; log err in full for diagnostics.
}
```

**Use the invoked function as context.** Since one call site invokes one contract function, the set of possible failures is already narrow. A failed `approve_withdraw` can only be one of six conditions, and pre-flight state tells you which — no message parsing needed.

**Never show a raw error to a user.** Panic strings, host error codes, and XDR fragments are diagnostic data. Log them; present a mapped message from the tables above.

For the full invocation flow and network configuration, see [apps/web/docs/api-soroban-client.md](../../apps/web/docs/api-soroban-client.md).

---

## Related documents

- [Frontend Soroban client](../../apps/web/docs/api-soroban-client.md) — the invocation flow and where each failure surfaces
- [Token transfer contract API](api-token-transfer.md) — full function reference
- [Proposals contract API](api-proposals.md) — full function reference
- [Proposal lifecycle](concepts-proposal-lifecycle.md) — statuses and legal transitions
- [Token transfer flow](concepts-token-transfer-flow.md) — the in-chat payment path
- [Deployment and invocation](api-deployment-invocation.md) — initialization, admin setup, and the treasury-admin wiring `execute_withdraw` depends on
- [Token transfer storage](contracts-token-transfer-storage.md) — storage keys behind the `not initialized` failures
- [Contract events reference](contracts-events.md) — the events a *successful* call emits, none of which survive a panic
- [Contract testing](testing.md) — how the panic paths above are exercised in the Rust test suites
- [Contract upgrades](concepts-upgrades.md) — the admin-gated `upgrade` path and its failure conditions
- [Resource budget](concepts-resource-budget.md) — the resource limits behind non-panic invocation failures
- [Contracts README](../README.md) — workspace layout, toolchain, build and test
