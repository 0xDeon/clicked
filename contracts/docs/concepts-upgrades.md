# Contract upgrades & versioning

How a deployed Soroban contract in this repo is replaced with new code, who is
allowed to do it, and which changes to the contract's storage layout are safe
across that swap.

The whole mechanism is a single function, `upgrade`, on **one** contract:
`token_transfer`. Everything below is anchored to
[`contracts/contracts/token_transfer/src/lib.rs`](../contracts/token_transfer/src/lib.rs).

---

## 1. Which contracts are upgradeable

| Contract         | Path                                 | Upgradeable | Mechanism                                                                  |
| ---------------- | ------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| `token_transfer` | `contracts/contracts/token_transfer` | **Yes**     | `upgrade(env, new_wasm_hash)` — admin-gated `update_current_contract_wasm` |
| `group_treasury` | `contracts/contracts/group_treasury` | **No**      | No upgrade entrypoint exists                                               |
| `proposals`      | `contracts/contracts/proposals`      | **No**      | No upgrade entrypoint exists                                               |

`group_treasury` and `proposals` expose no function that calls
`env.deployer().update_current_contract_wasm(...)`. Their deployed wasm is
immutable for the life of the contract instance. Changing their behaviour means
**deploying a new contract instance** and repointing every consumer at the new
contract ID (see [§7](#7-what-to-do-for-a-non-upgradeable-contract)).

`proposals` carries an admin address that its source comments describe as a hook
"a future upgrade can wire" for governance parameters. That is a note about
future work, not an upgrade path — there is no upgrade entrypoint on that
contract today.

---

## 2. Authorization: who may call `upgrade`

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized");
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
```

The gate is exactly one thing: `admin.require_auth()`, where `admin` is the
address written to `DataKey::Admin` by `initialize` and **never written again**.
`token_transfer` has no `set_admin`, no admin-transfer function, and no
multi-signer or timelock logic. The admin is fixed at initialization for the
lifetime of the contract instance.

Consequences that follow directly from that:

- **Any caller who can produce a valid signature for the admin address can
  replace the contract's entire code.** There is no second approval, no delay,
  and no on-chain veto.
- **The admin key cannot be rotated.** If the key is compromised there is no
  in-contract remedy — the attacker and the legitimate operator have identical
  authority, and the attacker can upgrade the contract to wasm that removes the
  legitimate operator's access.
- **A compromised admin key is total loss of control over the contract.** The
  attacker can upgrade to wasm that redirects every `transfer` to an address
  they control, or that drains any allowance the contract holds. Existing
  storage (`Admin`, `TokenContract`) survives the swap, so the new code starts
  with the contract's full state.
- **`set_token_contract` shares the same key.** The same compromise lets an
  attacker point the router at a malicious token contract without upgrading
  anything.

Because a compromised admin is unrecoverable, the admin address should be held to
the same standard as a treasury key — hardware-backed, or a Stellar multisig
account so that no single signer can act alone. This is an operational control;
the contract itself enforces nothing beyond a single signature.

### Verified by tests

[`contracts/contracts/token_transfer/src/test.rs`](../contracts/token_transfer/src/test.rs)
covers both sides of the gate:

- `test_upgrade_requires_admin_auth` — with the admin's auth mocked, the call
  passes the auth check and fails later at the wasm lookup, proving admin auth
  is _sufficient_.
- `test_upgrade_non_admin_panics` — with only a non-admin address authorized,
  the call panics at `require_auth()`, proving admin auth is _necessary_.

---

## 3. End-to-end upgrade procedure

All commands run from `contracts/` and use the Stellar CLI, matching
[the deployment guide](./api-deployment-invocation.md). Replace `testnet` with
your target network.

### 3.1 Build the new wasm

```bash
cargo build -p token_transfer --target wasm32-unknown-unknown --release
```

Output: `target/wasm32-unknown-unknown/release/token_transfer.wasm`.

Build with the workspace's release profile as committed — `contracts/Cargo.toml`
pins `opt-level = "z"`, `lto = true`, and `strip = "symbols"`. Changing profile
flags changes the binary and therefore its hash, so a hash produced under a
different profile will not match one anybody else builds.

Run the same gates CI runs before uploading anything:

```bash
cargo test -p token_transfer
cargo fmt --all -- --check
cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings -A dead_code -A clippy::too-many-arguments
```

### 3.2 Produce the wasm hash

Uploading the binary installs the code on the ledger without deploying an
instance, and returns its hash — this is the value `upgrade` takes:

```bash
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/token_transfer.wasm \
  --source <admin-identity> \
  --network testnet
# → 6ddb28e0980f643bb97350f7e3bacb0ff1fe74d846c6d4f2c625e766210fbb5b
```

The 32-byte value it prints is the `BytesN<32>` that `upgrade` expects.

### 3.3 Verify the hash before invoking

The hash is the _only_ thing binding the on-chain code to the source that was
reviewed. Verify it locally rather than trusting the upload output:

```bash
# The uploaded hash is the sha256 of the wasm file bytes.
sha256sum target/wasm32-unknown-unknown/release/token_transfer.wasm
```

That value must equal the hash printed by `stellar contract upload`. If they
differ, the binary that was uploaded is not the one on disk — stop.

A reviewer should independently reproduce the build from the reviewed commit and
confirm they get the same hash. Because the release profile is pinned in
`Cargo.toml` and the toolchain is pinned in
[`contracts/rust-toolchain.toml`](../rust-toolchain.toml), an independent build
of the same source should reproduce it. A mismatch means the toolchain or the
source differs, and the upgrade should not proceed until that is explained.

### 3.4 Invoke `upgrade`

```bash
stellar contract invoke \
  --id <TOKEN_TRANSFER_CONTRACT_ID> \
  --source <admin-identity> \
  --network testnet \
  -- upgrade --new_wasm_hash <HASH_FROM_STEP_3.2>
```

`--source` must be the admin identity — any other signer panics at
`require_auth()`.

### 3.5 Confirm the upgrade took effect

The contract emits no upgrade event, so confirmation is by observation:

```bash
# 1. State survived the swap — this must still return the configured token.
stellar contract invoke --id <CONTRACT_ID> --source <any> --network testnet \
  -- token_contract

# 2. New behaviour is live — call a function whose behaviour changed,
#    or one that only exists in the new wasm.
stellar contract invoke --id <CONTRACT_ID> --source <any> --network testnet \
  -- <new-or-changed-function>
```

A read of `token_contract` that panics with `not initialized` after an upgrade
means the new wasm is reading a different storage key than the old wasm wrote —
see [§4](#4-storage-layout-compatibility). Treat that as a live incident: the
contract still holds the old data, but the new code cannot see it.

The contract ID does **not** change across an upgrade. Backend and frontend
configuration (`TOKEN_TRANSFER_CONTRACT_ID`, the corresponding `NEXT_PUBLIC_*`)
needs no update. Clients holding a generated contract client **do** need
regenerating if function signatures changed.

---

## 4. Storage layout compatibility

`update_current_contract_wasm` swaps the code and **leaves storage untouched**.
The new wasm inherits every key the old wasm wrote, byte for byte. Nothing
migrates automatically and nothing is validated — a mismatch is silent until a
read fails or, worse, succeeds with the wrong data.

`token_transfer` stores two instance-scoped keys, defined in
[`storage.rs`](../contracts/token_transfer/src/storage.rs):

```rust
#[contracttype]
pub enum DataKey {
    TokenContract,  // Address of the SEP-41 token this contract routes through
    Admin,          // Address permitted to upgrade / set the token contract
}
```

Both are read via `env.storage().instance()`. There is no persistent or
temporary storage, so TTL and rent do not enter into the compatibility question
here.

### 4.0 How the key encoding actually works

The compatibility rules below follow from one fact about `#[contracttype]`, and
it is worth stating plainly because the intuition from other chains is wrong
here: **Soroban encodes by name, not by position.**

- A `#[contracttype]` **enum** encodes each variant as an `ScSymbol` of the
  variant's _identifier_ — `DataKey::Admin` is stored under the symbol
  `"Admin"`. Declaration order plays no part in the encoding.
- A `#[contracttype]` **struct** encodes as an `ScMap` keyed by the field names,
  sorted by name. Declaration order plays no part there either.

So the dangerous edits are the ones that change a **name** or a **type**, not the
ones that change an order. (`#[contracterror]` / `contracttype` _integer_ enums
are the exception — those do encode by discriminant — but `token_transfer` uses
neither.)

### 4.1 Safe changes

| Change                                                               | Why it is safe                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a **new** `DataKey` variant                                   | Existing variants keep their own name symbols, so old keys still resolve. The new key simply has no value yet — reads must handle absence.                                                                                      |
| **Reordering** existing `DataKey` variants                           | Variants encode by name, so order is not part of the key. Harmless, though a pointless diff.                                                                                                                                    |
| **Reordering** fields in a stored struct                             | Struct fields encode as a name-keyed map sorted by name, so declaration order is not part of the encoding.                                                                                                                      |
| Adding, removing, or changing contract **functions**                 | Functions are not storage. Callers of a removed function break, but stored state is unaffected.                                                                                                                                 |
| Changing function **bodies** (logic, validation, events emitted)     | No storage encoding is involved.                                                                                                                                                                                                |
| Adding a field to an **event** struct such as `TransferEvent`        | Events are emitted, never read back from storage. Off-chain consumers must tolerate the new shape, but no on-ledger state is corrupted.                                                                                         |
| Adding a field to a **stored** struct, if reads tolerate its absence | Old values decode without the new key. The decode fails unless the field is optional or the read path handles the missing key, so this needs a deliberate migration path — see [§4.3](#43-when-a-layout-change-is-unavoidable). |
| Changing the release profile or the SDK **patch** version            | Produces a different wasm hash, not a different storage layout.                                                                                                                                                                 |

### 4.2 Unsafe changes — these corrupt or orphan existing state

| Change                                                                        | What breaks                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renaming** a `DataKey` variant                                              | The key is the variant name. Renaming `Admin` to `Owner` makes the new wasm read a key nothing was ever stored under: `upgrade` and `set_token_contract` panic with `not initialized`, and the old admin value is orphaned on the ledger permanently. |
| **Removing** a variant that still has a value on the ledger                   | The value stays on-ledger, unreachable and unrecoverable, and continues to occupy the instance entry.                                                                                                                                                 |
| Changing a stored value's **type** (`Address` → `BytesN<32>`, `i128` → `u64`) | The old bytes are decoded as the new type. This either panics on read or, where the encodings happen to overlap, silently yields a wrong value.                                                                                                       |
| Changing an enum variant's **payload** (unit → tuple, or its inner types)     | `DataKey::Admin` and `DataKey::Admin(u32)` are different keys with different encodings. The old value becomes unreachable.                                                                                                                            |
| **Renaming** or **retyping** a field in a stored struct                       | Same as the enum: the map key is the field name. The old field's value is orphaned and the new field reads as missing. `token_transfer` stores no structs today, so this is a rule to preserve rather than a present hazard.                          |
| Moving a key between **storage scopes** (instance → persistent/temporary)     | The scopes are separate namespaces. The old value stays in instance storage and the new read finds nothing.                                                                                                                                           |
| Re-running `initialize` after an upgrade                                      | It panics — `initialize` guards on `DataKey::Admin` already existing. There is no re-initialization path, by design.                                                                                                                                  |

The worst case in that table is the rename, because it fails _closed_ in the most
expensive way possible: `Admin` renamed means nobody can authorize an `upgrade`
any more, so the mistake cannot be fixed by upgrading again. That is
unrecoverable for `token_transfer`. Treat any rename of a `DataKey` variant as a
change that must not ship.

### 4.3 When a layout change is unavoidable

There is no migration hook on this contract: no post-upgrade initializer, no
stored schema version, and no way to run code once at the moment of the swap. If
the layout must change, the migration has to be written into the new wasm itself
— an admin-only function invoked in the same operational window as the upgrade:

1. Upgrade to a wasm that understands **both** layouts and exposes a `migrate`
   function.
2. Invoke `migrate` as the admin. It reads the old keys, writes the new ones, and
   records that it ran so it cannot run twice.
3. Optionally upgrade again to a wasm that has dropped the old-layout code.

Rehearse the whole sequence on testnet, against a contract instance holding
representative state, before touching mainnet.

---

## 5. Versioning

The contract exposes no version. There is no `version()` function, no stored
version key, and no event announcing an upgrade — an observer cannot ask a
deployed `token_transfer` which build it is running.

In practice the deployed version is identified by the **wasm hash**, which is
what the ledger records and what `stellar contract upload` returns. Keep an
operational record mapping each upgrade to the git commit it was built from, the
hash that build produced, the network, and the date. The chain does not keep that
mapping for you.

Adding a `version()` entrypoint returning a compile-time constant is a safe
change under [§4.1](#41-safe-changes); storing the version under a new `DataKey`
variant is safe too — it is a new name, so nothing existing is disturbed.

---

## 6. Pre-upgrade checklist

- [ ] Change is reviewed and merged; the build is from a known commit.
- [ ] `cargo test -p token_transfer`, `cargo fmt --check`, and `cargo clippy` pass.
- [ ] Storage diff reviewed against [§4.2](#42-unsafe-changes--these-corrupt-or-orphan-existing-state) — no rename, removal, payload change, or type change of any `DataKey` variant.
- [ ] Local `sha256sum` matches the hash returned by `stellar contract upload`.
- [ ] A reviewer independently reproduced the build and got the same hash.
- [ ] Full sequence rehearsed on testnet against an initialized contract holding state.
- [ ] Admin key access confirmed and the signer identified before the invoke.
- [ ] Post-upgrade reads (`token_contract`, `balance`) planned as the confirmation step.

---

## 7. What to do for a non-upgradeable contract

`group_treasury` and `proposals` cannot be swapped in place. Changing them means:

1. Deploy a new instance from the new wasm — `contracts/scripts/deploy_group_treasury.sh`
   or `contracts/scripts/deploy_proposals.sh`.
2. Initialize it and re-establish its state. Members, thresholds, and balances do
   not carry across. Funds held by a `group_treasury` instance must be withdrawn
   through the old contract's own rules before the old instance is abandoned.
3. Update `GROUP_TREASURY_CONTRACT_ID` / `PROPOSALS_CONTRACT_ID` in the backend
   env and the corresponding `NEXT_PUBLIC_*` values in the frontend, per
   [§6 of the deployment guide](./api-deployment-invocation.md#6-how-a-deployed-contract-id-reaches-the-frontend--backend).
4. Accept that in-flight proposals on the old instance are stranded — they can
   still be voted on and executed against the old contract, which no client is
   pointed at any more.

Because there is no in-place path, treat a `group_treasury` or `proposals`
deployment as final and get the logic right before mainnet.

---

## 8. Related documents

- [Contract build, deployment & invocation guide](./api-deployment-invocation.md) — toolchain, build, deploy, and the invoke syntax used above
- [Token transfer storage layout & token interface](./contracts-token-transfer-storage.md) — the storage keys these compatibility rules apply to
- [Token transfer API](./api-token-transfer.md) — the function surface an upgrade may change
- [Token transfer flow](./concepts-token-transfer-flow.md) — how the contract is used end to end
