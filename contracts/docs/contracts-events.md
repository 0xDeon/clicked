# Contract Events Reference

Every `env.events().publish(...)` call across the three Soroban contracts, with its topic
tuple, data payload, the state change it signals, and whether the event is emitted before
or after that state is written.

These events are the only mechanism by which off-chain systems learn that on-chain state
changed. The backend's chain listener
([`apps/backend/src/services/stellarListener.ts`](../../apps/backend/src/services/stellarListener.ts))
polls Soroban RPC `getEvents` on a cursor and turns them into database writes and
WebSocket pushes — see the [Treasury API doc](../../apps/backend/docs/api-treasury.md) and
the [deployment and invocation doc](api-deployment-invocation.md) for how the listener is
configured and started.

**Emission order matters.** A consumer treats an event as proof that the state change
happened. Every event below is annotated with whether the `publish` call runs before or
after the corresponding `env.storage()` write, because two events in this codebase are
emitted *before* their write and one payload is therefore a projection of intended state
rather than committed state.

---

## Summary

| Contract | Topic | Consumed by the backend listener? |
| --- | --- | --- |
| `token_transfer` | `transfer` | ✅ Yes |
| `group_treasury` | `member_added` | ❌ No |
| `group_treasury` | `member_removed` | ❌ No |
| `group_treasury` | `deposit` | ❌ No |
| `group_treasury` | `withdraw` | ❌ No |
| `group_treasury` | `proposal_created` | ✅ Yes |
| `group_treasury` | `proposal_approved` | ✅ Yes |
| `group_treasury` | `proposal_rejected` | ✅ Yes |
| `group_treasury` | `withdraw_vote` | ❌ No |
| `proposals` | `proposal_created` | ⚠️ Only if the contract id is configured as a treasury contract |
| `proposals` | `vote_cast` | ❌ No |
| `proposals` | `proposal_finalized` | ❌ No |
| `proposals` | `proposal_expired` | ⚠️ Same caveat as above |
| `proposals` | `executed` | ❌ No |
| `proposals` | `execut` | ❌ No |

The listener also subscribes to a topic named **`proposal_executed`, which no contract
publishes.** See [Consumption gaps](#consumption-gaps).

---

## `token_transfer`

Source: [`contracts/token_transfer/src/lib.rs`](../contracts/token_transfer/src/lib.rs),
event structs in [`storage.rs`](../contracts/token_transfer/src/storage.rs).

### `transfer`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "transfer"),)` — single-element |
| **Data type** | `TransferEvent` |
| **Emitted in** | `transfer()`, `lib.rs:56` |
| **Order** | **After** the token move. `token.transfer(...)` executes first, so the event follows the balance change. |
| **Consumed** | ✅ Yes |

**Data payload**

| Field | Type | Meaning |
| --- | --- | --- |
| `from` | `Address` | Sender; authorised via `from.require_auth()`. |
| `to` | `Address` | Recipient. |
| `amount` | `i128` | Amount in token units; guaranteed `> 0` (the call panics otherwise). |
| `memo` | `Bytes` | Opaque reference. When the transfer originated from a chat message this carries that message's UUID. |

**State change signalled.** `amount` of the configured SEP-41 token has moved from `from`
to `to`. Note that `token_transfer` holds no balance state of its own — the authoritative
state change is in the token contract, and this event is the record that the routed
transfer succeeded.

**How the backend consumes it.** `buildRpcFetcher` filters on `topics: [['transfer']]` for
the `TOKEN_TRANSFER_CONTRACT_ID`. `defaultPersistEvent` hex-decodes `memo`, and if it
parses as a UUID matching a row in `messages`, associates the transfer with that message's
conversation and sender. It then upserts into `token_transfers` keyed on `tx_hash`, so a
reconnect that re-reads a page produces no duplicates.

> **Consumer caveat.** If the memo is absent or is not a UUID of an existing message, the
> listener falls back to *the first row* of `conversations` and `users` rather than
> skipping the row, because `conversationId` and `senderId` are non-nullable. Transfers
> not originating from a chat message are therefore attributed to an arbitrary
> conversation and user.

---

## `group_treasury`

Source: [`contracts/group_treasury/src/lib.rs`](../contracts/group_treasury/src/lib.rs),
event structs in [`storage.rs`](../contracts/group_treasury/src/storage.rs).

This contract publishes nine events across membership, funds movement, and every proposal
transition.

### Membership

#### `member_added`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "member_added"),)` |
| **Data type** | `MemberAddedEvent` |
| **Emitted in** | `add_member()`, `lib.rs:79` |
| **Order** | **After** the write — the updated `Members` vector is persisted first. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `member` | `Address` | The address added to the member set. |
| `added_by` | `Address` | The admin that performed the change. |

**State change.** `DataKey::Members` now contains `member`. Admin-only; re-adding an
existing member panics.

#### `member_removed`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "member_removed"),)` |
| **Data type** | `MemberRemovedEvent` |
| **Emitted in** | `remove_member()`, `lib.rs:116` |
| **Order** | **After** the write. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `member` | `Address` | The address removed. |
| `removed_by` | `Address` | The admin that performed the change. |

**State change.** `DataKey::Members` no longer contains `member`. Removing a non-member
panics.

> **Note for consumers.** Membership changes the denominator of the rejection rule — the
> blocking minority is computed from the *current* member count at vote time. Since these
> two events are unconsumed, the backend's mirror of the member set can drift from chain.

### Funds

#### `deposit`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "deposit"),)` |
| **Data type** | `DepositEvent` |
| **Emitted in** | `deposit()`, `lib.rs:168` |
| **Order** | **After** both the token transfer and the balance write. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `from` | `Address` | Depositor; authorised via `require_auth()`. |
| `amount` | `i128` | Amount deposited; guaranteed `> 0`. |

**State change.** Tokens moved into the contract and `DataKey::Balances[token]` increased
by `amount`.

> **Payload gap.** `DepositEvent` does not carry the `token` address, even though the
> function takes one and balances are tracked per token. A consumer cannot tell which
> token was deposited from the event alone.

#### `withdraw`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "withdraw"),)` |
| **Data type** | `WithdrawEvent` |
| **Emitted in** | `withdraw()`, `lib.rs:198` |
| **Order** | **After** both the token transfer and the balance write. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `to` | `Address` | Recipient of the funds. |
| `amount` | `i128` | Amount withdrawn. |

**State change.** Tokens left the contract and `DataKey::Balances[token]` decreased by
`amount`. Admin-only, and panics if the balance is insufficient.

This is also the event emitted when `proposals::execute_withdraw` calls into this contract
cross-contract, so it is the on-chain record that an approved governance withdrawal
actually moved funds.

> **Payload gap.** As with `deposit`, `WithdrawEvent` omits the `token` address.

### Proposal lifecycle

#### `proposal_created`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_created"),)` |
| **Data type** | `ProposalCreatedEvent` |
| **Emitted in** | `propose_withdraw()`, `lib.rs:275` |
| **Order** | **After** the proposal and the proposer's auto-approval vote are written. |
| **Consumed** | ✅ Yes → status `active` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u32` | Proposal id, assigned from `ProposalCount`. |
| `proposer` | `Address` | Must be a member; auto-approves, so the proposal starts at `approvals = 1`. |
| `to` | `Address` | Withdrawal recipient if the proposal passes. |
| `token` | `Address` | Token to withdraw. |
| `amount` | `i128` | Amount requested; checked against the current balance at creation. |
| `expires_at` | `u64` | Unix timestamp, computed as `now + ttl_ledgers * 5` (≈5 s per ledger). |

**State change.** A new `WithdrawProposal` exists with `status = Active`,
`approvals = 1`, `rejections = 0`; `ProposalCount` incremented; the proposer's vote
recorded.

#### `proposal_approved`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_approved"),)` |
| **Data type** | `ProposalApprovedEvent` |
| **Emitted in** | `approve_withdraw()`, `lib.rs:311` — **conditional**, only when the threshold is reached |
| **Order** | ⚠️ **Before** the write. The status is set on the in-memory struct and the event published, and only then is the proposal persisted (`lib.rs:320`). |
| **Consumed** | ✅ Yes → status `approved` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u32` | Proposal id. |
| `approvals` | `u32` | Approval count that met the threshold. |
| `threshold` | `u32` | The configured threshold, for context. |

**State change.** The proposal transitioned `Active → Passed`. It is now executable.

Emitted at most once per proposal, only on the vote that crosses the threshold. Because
the whole call is one atomic transaction, the pre-write emission is not observable to an
off-chain consumer — if the transaction reverts, no event is delivered — but the ordering
is worth knowing when reading the contract.

#### `proposal_rejected`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_rejected"),)` |
| **Data type** | `ProposalRejectedEvent` |
| **Emitted in** | `reject_withdraw()`, `lib.rs:361` — **conditional**, only at the blocking minority |
| **Order** | ⚠️ **Before** the write, same pattern as `proposal_approved` (persisted at `lib.rs:369`). |
| **Consumed** | ✅ Yes → status `rejected` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u32` | Proposal id. |
| `rejections` | `u32` | Rejection count that reached the blocking minority. |

**State change.** The proposal transitioned `Active → Rejected`. The blocking minority is
`member_count.saturating_sub(threshold) + 1` — the point at which the remaining members can
no longer reach `threshold` approvals.

#### `withdraw_vote`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "withdraw_vote"),)` |
| **Data type** | `WithdrawVoteCastEvent` |
| **Emitted in** | `approve_withdraw()` `lib.rs:325` **and** `reject_withdraw()` `lib.rs:374` |
| **Order** | **After** the proposal write in both paths. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u32` | Proposal id. |
| `voter` | `Address` | The member who voted. |
| `approve` | `bool` | `true` = approve, `false` = reject. |

**State change.** One vote recorded at `DataKey::Vote(id, voter)`, and the proposal's
`approvals` or `rejections` counter incremented by one. Each member may vote at most once.

This is emitted on **every** vote, whereas `proposal_approved` / `proposal_rejected` fire
only on the transition. A vote that crosses the threshold therefore produces two events in
one transaction — the transition event first, then `withdraw_vote`.

> **Note.** The proposer's auto-approval at creation does **not** emit a `withdraw_vote`,
> even though it is recorded as a vote. Counting `withdraw_vote` events undercounts
> approvals by one.

---

## `proposals`

Source: [`contracts/proposals/src/lib.rs`](../contracts/proposals/src/lib.rs), event
structs in [`storage.rs`](../contracts/proposals/src/storage.rs). Note this contract uses
`u64` proposal ids, whereas `group_treasury` uses `u32`.

### `proposal_created`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_created"),)` |
| **Data type** | `ProposalCreatedEvent` (distinct from the `group_treasury` type of the same name) |
| **Emitted in** | `create_proposal()`, `lib.rs:100` |
| **Order** | **After** the proposal and `NextProposalId` are written. |
| **Consumed** | ⚠️ Only if this contract id is configured as `GROUP_TREASURY_CONTRACT_ID` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id from `NextProposalId`. |
| `proposer` | `Address` | Creator; authorised via `require_auth()`. |
| `expires_at` | `u64` | Voting deadline; must be in the future. |
| `treasury` | `Address` | The `group_treasury` this proposal would withdraw from. |
| `token` | `Address` | Token to withdraw. |
| `to` | `Address` | Withdrawal recipient. |
| `amount` | `i128` | Amount requested; must be `> 0`. |

**State change.** A new `Proposal` exists with `status = Active` and
`yes_votes = no_votes = 0`. Unlike `group_treasury`, the proposer does **not** auto-vote.

> Note the shared topic name across two contracts with different payload shapes and
> different id widths. Consumers must disambiguate on the emitting contract id, not the
> topic alone.

### `vote_cast`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "vote_cast"),)` |
| **Data type** | `VoteCastEvent` |
| **Emitted in** | `vote()`, `lib.rs:144` |
| **Order** | **After** both the vote key and the updated proposal are written. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id. |
| `voter` | `Address` | The voter. |
| `support` | `bool` | `true` = yes, `false` = no. |

**State change.** `DataKey::Vote(id, voter)` set, and `yes_votes` or `no_votes`
incremented. One vote per address per proposal; voting after `expires_at` panics.

### `proposal_finalized`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_finalized"),)` |
| **Data type** | `ProposalFinalizedEvent` |
| **Emitted in** | `finalize_proposal()`, `lib.rs:180` |
| **Order** | **After** the status write. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id. |
| `status` | `ProposalStatus` | The outcome: `Passed` or `Rejected`. |
| `yes_votes` | `u32` | Final yes tally. |
| `no_votes` | `u32` | Final no tally. |

**State change.** `Active → Passed` when `yes_votes > no_votes`, otherwise
`Active → Rejected`. Callable by anyone, but only after `expires_at`. A tie rejects.

> **Consumption gap.** This is the event that decides a governance proposal's outcome, and
> nothing consumes it. The backend has no listener-driven path to learn that a `proposals`
> vote passed.

### `proposal_expired`

| | |
| --- | --- |
| **Topic tuple** | `(Symbol::new(&env, "proposal_expired"),)` |
| **Data type** | `ProposalExpiredEvent` |
| **Emitted in** | `finalize_expired_proposal()`, `lib.rs:208` |
| **Order** | **After** the status write. |
| **Consumed** | ⚠️ Only if this contract id is configured as `GROUP_TREASURY_CONTRACT_ID` |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id. |

**State change.** `Active → Expired`. This is an alternative terminal path to
`finalize_proposal`: whichever is called first wins, since both require `Active`.

### `executed`

| | |
| --- | --- |
| **Topic tuple** | `(symbol_short!("executed"),)` |
| **Data type** | `ProposalExecutedEvent` |
| **Emitted in** | `execute_proposal()`, `lib.rs:228` |
| **Order** | **After** the status write. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id. |
| `executor` | `Address` | Whoever executed it. |

**State change.** `Passed → Executed`. This is the MVP execution path: it only flips the
status and emits, moving no funds.

### `execut`

| | |
| --- | --- |
| **Topic tuple** | `(symbol_short!("execut"),)` — note the truncated symbol |
| **Data type** | `ProposalExecutedEvent` |
| **Emitted in** | `execute_withdraw()`, `lib.rs:285` |
| **Order** | **After** the status write, and after the cross-contract withdrawal. |
| **Consumed** | ❌ No |

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `u64` | Proposal id. |
| `executor` | `Address` | The treasury member who executed; must pass a membership check. |

**State change.** `Passed → Executed`, **and** funds have moved: the contract called
`group_treasury::withdraw` cross-contract before writing the status. That call causes
`group_treasury` to emit its own `withdraw` event in the same transaction.

So an executed governance withdrawal produces two events from two contracts:
`group_treasury::withdraw` (funds moved) and `proposals::execut` (proposal closed).

> **Naming defect.** Two different topics — `executed` and `execut` — signal the same
> logical transition with the same payload type. `symbol_short!` caps at 9 characters, so
> `"executed"` (8) was in range and the truncation in `execut` appears unintentional rather
> than forced. Consumers must match both.

---

## Consumption gaps

Collected here because these are the differences between what the contracts publish and
what the backend actually reacts to. Each is a real defect, not a design choice.

### 1. The listener subscribes to a topic nothing publishes

`stellarListener.ts` declares `TREASURY_TOPICS` as:

```
proposal_created, proposal_approved, proposal_rejected, proposal_executed, proposal_expired
```

**No contract publishes `proposal_executed`.** `proposals` publishes `executed` and
`execut`; `group_treasury` has no execution event at all. The listener's status map
contains `proposal_executed: 'executed'`, so the code path exists but is unreachable —
a proposal never reaches the `executed` status in the off-chain mirror by way of the
listener. The [treasury API doc](../../apps/backend/docs/api-treasury.md) and
[deployment doc](api-deployment-invocation.md) both list `proposal_executed` among the
watched events, which is accurate about the subscription and misleading about the effect.

### 2. `group_treasury` has no execution event

`group_treasury::withdraw` emits `withdraw`, but there is no
`proposal_executed`-equivalent tying a fund movement back to the proposal that authorised
it. A consumer watching only treasury topics cannot close the loop from
`proposal_approved` to "the money moved".

### 3. Fund movement is entirely unconsumed

`deposit` and `withdraw` — the two events that represent actual value movement — have no
consumer. Treasury balances shown off-chain cannot be maintained from the event stream as
it stands.

### 4. Only one contract is watched for treasury topics

The listener builds a single treasury fetcher from one `GROUP_TREASURY_CONTRACT_ID`. The
`proposals` contract is a separate deployment with its own id, so whichever id is
configured, the other contract's events are not polled. Since both contracts publish a
topic named `proposal_created` with different payloads and different id widths (`u32` vs
`u64`), pointing the listener at `proposals` would also mis-parse — the fetcher reads
`value.approvals` and `value.rejections`, which exist only on the `group_treasury` events.

### 5. Vote-level events are unconsumed

`withdraw_vote` and `vote_cast` are not consumed. Live vote tallies in the UI come from the
off-chain `proposalVotes` table written by the REST routes, not from chain. On-chain votes
cast directly against the contract are therefore invisible to the backend until a
transition event fires.

---

## Related documents

- [Backend chain listener source](../../apps/backend/src/services/stellarListener.ts) — the consumer
- [Treasury API](../../apps/backend/docs/api-treasury.md) — the REST surface and off-chain mirror
- [Deployment and invocation](api-deployment-invocation.md) — env vars that start the listener
- [Proposal lifecycle](concepts-proposal-lifecycle.md) — statuses and transitions in full
- [Token transfer flow](concepts-token-transfer-flow.md) — the in-chat payment path
- [System architecture overview](../../docs/architecture-overview.md) — how the listener fits the whole system
