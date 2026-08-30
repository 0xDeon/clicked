# Contract testing guide

How the Soroban test environment is used across the three contracts in this workspace
(`token_transfer`, `group_treasury`, `proposals`): the standard scaffolding, how
authorization is tested (and how to avoid hiding a missing `require_auth`), how
time-dependent behaviour like proposal expiry is exercised, and how cross-contract tests
wire `proposals` into `group_treasury`.

All examples below are taken from the real test suites in this workspace — see
`contracts/contracts/*/src/test.rs`.

---

## Standard test scaffolding

Every contract test module is gated with `#![cfg(test)]` and starts from a fresh
`Env::default()`. There is no shared/global environment between tests — each `#[test]`
function builds its own.

```rust
#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::Env;

#[test]
fn create_then_vote_then_pass_then_execute_happy_path() {
    let env = Env::default();
    let (client, _admin, alice, bob, carol, ..) = setup(&env);

    let id = create_proposal_in(&env, &client, &alice, 1_000, /* ... */);

    client.vote(&alice, &id, &true);
    client.vote(&bob, &id, &true);
    client.vote(&carol, &id, &false);

    advance_time(&env, 1_001);
    let status = client.finalize_proposal(&id);
    assert_eq!(status, ProposalStatus::Passed);
}
```

### Address generation

Test addresses are never hardcoded strings — they are generated per-test with
`Address::generate(&env)`, which requires `soroban_sdk::testutils::Address` to be in scope
(imported as `Address as _` since only the trait method is used, not the type name):

```rust
use soroban_sdk::testutils::Address as _;

let alice = Address::generate(&env);
let bob = Address::generate(&env);
```

Each call produces a fresh, unique address scoped to that `env`. Addresses are never reused
across tests.

### The `setup()` helper

Each contract's test module defines a `setup(&env)` helper that registers the contract(s),
generates the standard cast of addresses (an admin plus a small number of named actors —
`alice`, `bob`, `carol` are the convention here), and returns a tuple of the client plus
every address the test body will need. Keeping this in one function means every test starts
from the same known-good state and individual tests stay short.

Where a contract needs a token to move, `setup()` also registers a minimal `mock_token`
module scoped to the test file (`#[contract] struct MockToken` with `mint`/`transfer`/
`balance`) rather than depending on a real token contract. This keeps tests fast and
self-contained, and lets tests that only care about authorization use a token whose
`transfer` still calls real `require_auth()`.

---

## Testing authorization

Soroban's test host does not simulate real signatures. Instead, `Env` exposes mocking
utilities that make `require_auth()` calls succeed (or fail) without a signature ever being
produced. Three levels are used across this workspace, in increasing order of precision:

### 1. `mock_all_auths()` — blanket mocking

```rust
let env = Env::default();
env.mock_all_auths();
```

This makes **every** `require_auth()` / `require_auth_for_args()` call in the transaction
succeed, regardless of which address it was called on. It is the fastest way to get a
happy-path test running, and it is what most tests in this workspace use.

**The risk:** `mock_all_auths()` proves nothing about *which* address is required to
authorize a call — only that *some* auth check, if present, would pass. A contract method
that is missing a `require_auth()` call entirely will pass a `mock_all_auths()`-based test
just as easily as a correct one. Blanket mocking is safe for tests whose purpose is
something other than authorization (e.g. asserting vote tallying, or balance arithmetic),
but it must never be the *only* test covering a security-sensitive entry point.

### 2. `mock_all_auths_allowing_non_root_auth()` — cross-contract calls

`proposals::execute_withdraw` calls `group_treasury::withdraw`, which itself calls
`admin.require_auth()` as a **nested** (non-root) invocation — the admin address never
appears in the root call's argument list. The default `mock_all_auths()` only mocks
auth for the root invocation, so cross-contract setups that need a nested `require_auth`
to succeed use the non-root variant instead:

```rust
// execute_withdraw calls treasury.withdraw() as a nested (non-root) call, which
// itself calls admin.require_auth() — an address not present in the root
// invocation's argument list, so the non-root variant is required.
env.mock_all_auths_allowing_non_root_auth();
```

### 3. `env.auths()` and `mock_auths()` — asserting the real requirement

To actually prove that a specific address's authorization is required — not just that
*an* auth check exists — combine one of two techniques:

**Assert which address was required**, after a successful call under blanket mocking:

```rust
env.mock_all_auths();
client.transfer(&sender, &receiver, &100, &memo);

let auths = env.auths();
assert!(auths.iter().any(|(addr, _)| *addr == sender));
```

**Mock auth for one address only**, and confirm the call panics when the address that
should be required did not authorize:

```rust
#[test]
#[should_panic]
fn test_upgrade_non_admin_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = setup_with_admin(&env, &admin);
    let client = TokenTransferContractClient::new(&env, &contract_id);

    // Only mock auth for a non-admin address. The contract must panic when
    // require_auth() is invoked on `admin`, because `admin` never signed.
    let intruder = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &intruder,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "upgrade",
            args: soroban_sdk::vec![&env],
            sub_invokes: &[],
        },
    }]);

    client.upgrade(&wasm_hash); // panics: admin never authorized
}
```

**Test with no mocking at all**, when the point of the test is that the call must fail
without authorization:

```rust
#[test]
#[should_panic]
fn test_vote_without_auth_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let member = Address::generate(&env);
    // ... register + initialize the contract ...

    env.mock_all_auths();
    client.add_member(&member);
    // ...
    env.set_auths(&[]); // clear mocked auths — the vote must now fail

    client.approve_withdraw(&member, &0); // panics: no auth present
}
```

`env.set_auths(&[])` is useful when setup steps genuinely need mocked auth (e.g.
initializing a contract as admin) but the assertion under test needs a clean slate with
none mocked.

**Rule of thumb:** every entry point that calls `require_auth()` should have at least one
test that exercises the real requirement — via `env.auths()`, a scoped `mock_auths()`, or
an unmocked `should_panic` test — in addition to any `mock_all_auths()`-based happy-path
tests. A codebase with only blanket-mocked tests can silently lose a `require_auth()` call
in a refactor and no test will catch it.

---

## Testing time-dependent behaviour (expiry)

Soroban's test `Env` uses a virtual ledger clock (`env.ledger()`), which starts at a fixed
timestamp and only advances when a test explicitly moves it forward. This makes
expiry-style logic deterministic to test: no real waiting, no flaky timers.

The convention in this workspace is a small `advance_time` helper:

```rust
use soroban_sdk::testutils::Ledger;

fn advance_time(env: &Env, seconds: u64) {
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + seconds);
}
```

Usage — a proposal created with a 500-second voting window cannot be finalized before
expiry, and must be finalizable once the clock has passed it:

```rust
#[test]
#[should_panic(expected = "cannot finalize before expiry")]
fn finalize_before_expiry_panics() {
    let env = Env::default();
    let (client, .., alice, .., m, token_id) = setup(&env);
    let id = create_proposal_in(&env, &client, &alice, 1_000, &m, &token_id, &alice, 1);

    client.finalize_proposal(&id); // no advance_time — still active
}

#[test]
fn finalize_expired_success() {
    let env = Env::default();
    let (client, .., alice, .., m, token_id) = setup(&env);
    let id = create_proposal_in(&env, &client, &alice, 500, &m, &token_id, &alice, 1);

    advance_time(&env, 501); // past the 500s window
    client.finalize_expired_proposal(&id);

    assert_eq!(client.get_proposal(&id).status, ProposalStatus::Expired);
}
```

Both the "too early" boundary (`should_panic`, no time advance) and the "just past expiry"
boundary (advance exactly past the window) should be covered for any time-gated state
transition — off-by-one errors in expiry math are easy to introduce and easy to catch this
way.

---

## Cross-contract test setup: `proposals` calling into `group_treasury`

`proposals::execute_withdraw` invokes `group_treasury::withdraw` as a real cross-contract
call inside the test host — not a mock of the treasury contract. The `proposals` test
`setup()` registers both contracts in the same `Env` and wires the treasury's address into
the proposal so the nested call resolves correctly:

```rust
fn setup(env: &Env) -> ( /* ... */ ) {
    // Nested require_auth() inside execute_withdraw needs the non-root variant.
    env.mock_all_auths_allowing_non_root_auth();

    let proposals_id = env.register(ProposalsContract, ());
    let proposals = ProposalsContractClient::new(env, &proposals_id);
    proposals.initialize(&proposals_admin);

    let token_id = env.register(mock_token::MockToken, ());
    let token = MockTokenClient::new(env, &token_id);
    token.mint(&treasury_member, &1_000_000);

    let treasury_addr = env.register(group_treasury::GroupTreasuryContract, ());
    let treasury = group_treasury::GroupTreasuryContractClient::new(env, &treasury_addr);
    treasury.initialize(&treasury_admin, &token_id, &1);
    treasury.add_member(&treasury_member);
    treasury.deposit(&treasury_member, &token_id, &500);

    (proposals, proposals_admin, alice, bob, carol, treasury, treasury_admin, treasury_member, token_id)
}
```

Points worth keeping in mind when writing a test like this:

- The `proposals` crate depends on `group_treasury` as a regular Rust dependency (see
  `contracts/contracts/proposals/Cargo.toml` and `treasury_interface_client.rs`), so the
  treasury client type is available directly — no WASM re-import step is needed inside
  tests.
- Both contracts are registered against the **same** `env`, which is what makes the nested
  invocation and its nested `require_auth()` resolvable at all.
  `mock_all_auths_allowing_non_root_auth()` (not plain `mock_all_auths()`) is required for
  exactly this reason — see [Testing authorization](#testing-authorization) above.
  Registering the deposit is done through the treasury client's own `deposit()` method
  (which itself calls the mock token's `transfer`) so the treasury has a real balance for
  `execute_withdraw` to draw down, rather than writing to treasury storage directly.
- Assertions after `execute_withdraw` read state back through the *treasury's* client
  (`treasury.balance(&token_id)`), confirming the effect actually crossed the contract
  boundary rather than only checking the proposal's own status flipped to `Executed`.

---

## The `test_snapshots/` directory

Running `cargo test` against a Soroban contract writes ledger/state snapshot files under
each contract's `test_snapshots/` directory (e.g.
`contracts/contracts/proposals/test_snapshots/`). These capture the test host's storage
state at the end of each test run and are how Soroban's test harness detects unexpected
storage-footprint changes between runs.

- **Generated, not hand-written.** Never edit files under `test_snapshots/` by hand — they
  are regenerated automatically the next time the corresponding test runs.
- **Committed.** Despite being generated, these files are checked into the repository. They
  are part of what makes a contract's storage footprint reviewable in a diff — a PR that
  unexpectedly grows a snapshot is a signal worth looking at during review.
- **Prettier-ignored.** The root `.prettierignore` excludes `contracts/**/test_snapshots/`
  under the "generated artifacts" section, alongside `apps/backend/drizzle/meta/` and
  `**/*.d.ts`. This is intentional: reformatting a generated, machine-written file produces
  noisy diffs and gets overwritten on the next test run regardless.

If a snapshot diff shows up in a PR that didn't intentionally change contract storage
layout, treat it as a signal to re-check the change rather than committing it as noise.
