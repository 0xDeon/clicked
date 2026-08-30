# WASM Size and Resource Budget

Deployed contract size is enforced in CI. This document covers what the gate is, where it
lives, how much room each contract currently has, which build settings move the number,
what to do when a contract approaches the limit, and why raw size is only one of several
budgets a Soroban contract has to live within.

---

## The gate

**Every release WASM must be ≤ 102,400 bytes (100 KB). A contract over the limit fails
the build.**

Enforced in [`.github/workflows/contracts-ci.yml`](../../.github/workflows/contracts-ci.yml),
in the `Report WASM binary sizes` step of the `test-and-build` job:

```bash
THRESHOLD_BYTES=102400  # 100 KB
...
if [ "$bytes" -gt "$THRESHOLD_BYTES" ]; then
  echo "::error file=${name}::WASM size ${bytes} bytes exceeds ${THRESHOLD_BYTES} byte limit"
  FAILED=1
fi
...
exit $FAILED
```

Mechanics worth knowing:

- **Triggers** on any push or pull request touching `contracts/**` or the workflow file
  itself, and on a weekly Monday 08:00 UTC schedule.
- **Runs per contract.** The job is a matrix over `token_transfer`, `group_treasury`, and
  `proposals`, with `fail-fast: false`, so one oversized contract does not mask the others.
- **Measures the plain `cargo build --release` artifact** from
  `target/wasm32-unknown-unknown/release/`. There is no post-processing step in CI — no
  `wasm-opt`, no `stellar contract optimize` — so the number gated is the raw compiler
  output.
- **Reports before it fails.** The step is `if: always()` and computes the whole size table
  before exiting non-zero, so a failing run still shows every contract's size.
- **Posts a size table to the pull request** as an update-in-place comment, keyed on a
  `<!-- wasm-size-report -->` marker so repeated pushes edit one comment instead of
  accumulating. The same table is written to the job summary. Comment failures are
  swallowed with `|| true`; they do not fail the build.
- **The gate is per-contract, not cumulative.** Three contracts at 90 KB each all pass.

> The size step shells out to `bc`. It is present on the `ubuntu-latest` runner but is not
> installed by default in every environment — worth knowing if you reproduce this step
> locally and it fails on a missing command rather than on size.

---

## Current sizes and headroom

Measured from `cargo build --release --target wasm32-unknown-unknown` at the current
workspace settings:

| Contract | Size | % of gate | Headroom |
| --- | --- | --- | --- |
| `group_treasury` | 31,843 B (31.10 KB) | 31.1 % | 70,557 B (68.90 KB) |
| `proposals` | 25,931 B (25.32 KB) | 25.3 % | 76,469 B (74.68 KB) |
| `token_transfer` | 10,539 B (10.29 KB) | 10.3 % | 91,861 B (89.71 KB) |

**Nothing is close to the limit.** The largest contract uses under a third of its budget,
and every contract could roughly triple in size before CI complains. Reproduce these
numbers with:

```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown
wc -c target/wasm32-unknown-unknown/release/*.wasm
```

Sizes will drift with `soroban-sdk` upgrades as much as with your own code, so treat the
table as a snapshot rather than a constant — the reproduction command above is the
authority.

The relative ordering is what you would expect from the source: `group_treasury` carries
membership management, per-token balances, and a full proposal-voting flow; `proposals`
carries a voting flow plus a cross-contract client; `token_transfer` is a thin authorised
wrapper over a SEP-41 transfer.

---

## Release profile settings that affect size

From [`contracts/Cargo.toml`](../Cargo.toml):

```toml
[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

Every one of these is already tuned for size. What each does, and what it costs to change:

| Setting | Effect on size | Cost of changing it |
| --- | --- | --- |
| `opt-level = "z"` | Optimises for size over speed; the single biggest lever. | Moving to `"s"` trades a little size for a little speed; `3` inflates size significantly. On Soroban, CPU is metered separately and code size is charged at deploy, so `"z"` is usually right. |
| `lto = true` | Whole-program link-time optimisation; removes cross-crate dead code. Large win against a big dependency like `soroban-sdk`. | Slower builds. Disabling it inflates size noticeably. |
| `codegen-units = 1` | One codegen unit lets LLVM see everything at once, improving both inlining and dead-code elimination. | Slower, non-parallel builds. Purely a build-time cost. |
| `strip = "symbols"` | Drops the symbol table from the artifact. | Backtraces lose names — irrelevant here, since `panic = "abort"` means no unwinding anyway. |
| `debug = 0` | No debug info in the binary. | No source-level debugging of the deployed artifact. |
| `panic = "abort"` | No unwinding tables or landing pads. Required for Soroban regardless. | Not optional in practice. Panics trap; there is nothing to unwind into. |
| `debug-assertions = false` | Drops `debug_assert!` and related checks. | Those checks stop running in release. |
| `overflow-checks = true` | **Costs** size — it keeps arithmetic overflow checks in the release build. | **Do not turn this off to save bytes.** These contracts move funds; a silent `i128` wraparound in a balance is a critical bug. This is a deliberate trade of size for safety, and the current headroom means there is no reason to revisit it. |

There is also a `release-with-logs` profile that inherits `release` and re-enables
`debug-assertions`, for local debugging. It is not what CI measures.

---

## When a contract approaches the limit

In rough order of effort-to-payoff. Measure after each step — guessing at what is large is
usually wrong.

### 1. Find out what is actually big

Before changing anything, look at the breakdown:

```bash
cargo install twiggy
twiggy top -n 30 target/wasm32-unknown-unknown/release/group_treasury.wasm
twiggy dominators target/wasm32-unknown-unknown/release/group_treasury.wasm
```

`twiggy top` ranks by retained size; `dominators` shows which item's removal would actually
free space. Frequently the bulk is a formatting or serialisation path pulled in by a single
call site.

### 2. Run the optimiser

CI gates the raw build output, but a deployed contract does not have to be that artifact:

```bash
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/group_treasury.wasm
```

This runs `wasm-opt` and typically removes a meaningful fraction. Note the asymmetry — the
optimised artifact is smaller than the number CI gates, so a contract that passes CI is
comfortably deployable, and a contract that *fails* CI may still be deployable. Fix the
source rather than relying on that gap.

### 3. Remove panic message strings

Every distinct `panic!("...")` literal is bytes in the data section. These contracts panic
with descriptive strings throughout (`"insufficient funds"`, `"proposal not found"`,
`"already voted"`, and so on). Converting to a `#[contracterror]` enum with numeric codes
removes the strings and gives callers a typed error instead:

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InsufficientFunds = 1,
    ProposalNotFound = 2,
    AlreadyVoted = 3,
}
```

This is usually the largest available win in a contract of this style, and it improves the
client experience rather than degrading it.

### 4. Avoid formatting machinery

`format!`, `write!`, and `{:?}` pull in Rust's formatting infrastructure, which is large
relative to a 100 KB budget. `#[derive(Debug)]` on a type that is never actually printed
is usually free after LTO, but an actual `{:?}` call site is not. In `no_std` Soroban code
these should not appear in the shipped path at all — keep them behind `#[cfg(test)]`.

### 5. Deduplicate generics and large call sites

A generic function instantiated over many types produces a copy per instantiation. If a
helper is used across many `DataKey` variants, having it take a concrete type — or funnel
through one non-generic inner function — collapses several copies into one. The same
applies to a large function inlined at many call sites; `#[inline(never)]` can shrink the
total.

### 6. Split the contract

If one contract genuinely needs more than 100 KB of logic, that is a signal to split it
along a real boundary and call across contracts, as `proposals` already does with
`group_treasury`. Cross-contract calls cost CPU instructions at runtime, so this trades
deploy size for execution cost — make it a design decision, not a size workaround.

### 7. Raise the gate — last resort

`THRESHOLD_BYTES` in the workflow is a project policy, not a protocol limit. Raising it is
legitimate if a contract has genuinely outgrown the budget, but do it deliberately and in
its own commit with the reasoning, not as a way to make a red build green.

---

## Size is not the only budget

A contract that fits in 100 KB can still be too expensive to use. Soroban meters several
resources independently, and each has its own ceiling and its own fee component:

- **CPU instructions.** Metered per invocation against a per-transaction ceiling. Loops
  over unbounded collections are the usual way to exceed it. Several functions here iterate
  the full member set (`is_member`, `add_member`, `remove_member`) or the full proposal
  range (`list_proposals`, `get_pending_proposals`), so their cost grows linearly with the
  treasury's membership and proposal history. These are the parts that will hit a ceiling
  long before code size does.
- **Memory.** A per-invocation limit on linear memory. Materialising a large `Vec` — for
  example building a list of every proposal ever created — is the usual cause.
- **Ledger entry reads and writes.** Both the number of entries touched and their total
  byte size are metered, and writes cost considerably more than reads. Note that these
  contracts keep everything in **instance** storage, including per-proposal entries and
  per-voter vote keys, so the instance entry grows without bound as proposals and votes
  accumulate — and the whole entry is read and written on every call that touches it. This
  is the most likely resource problem in this codebase.
- **Events.** Event topics and data count toward the transaction's resource usage. The
  events published here are small, but emitting one per vote in a large group adds up.
- **Rent / TTL.** Contract data expires unless its TTL is extended, and the cost of
  extension scales with entry size and duration. A large, long-lived instance entry is a
  recurring cost, not a one-off. This is the second reason to care about instance-storage
  growth: it is charged for as long as the contract lives, whereas code size is charged
  once at deploy.
- **Transaction size.** The signed transaction, including arguments and the authorisation
  footprint, has its own limit, independent of the contract's size.

**Practical upshot:** the 100 KB gate protects deployability, and at 31 % of budget it is
not the binding constraint today. The constraint that will bind first is unbounded growth
in instance storage and the linear scans over it. When optimising a contract here, look at
storage layout and iteration before looking at code size.

---

## Related documents

- [Contracts README](../README.md) — workspace layout, toolchain, build and test
- [Deployment and invocation](api-deployment-invocation.md) — deploying and initialising each contract
- [Token transfer storage](contracts-token-transfer-storage.md) — storage keys and value types
- [Proposal lifecycle](concepts-proposal-lifecycle.md) — statuses and transitions
- [Contract events reference](contracts-events.md) — every published event and its payload
