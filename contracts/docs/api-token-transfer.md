# Token transfer contract API reference

This document covers the public entry points in [contracts/contracts/token_transfer/src/lib.rs](contracts/contracts/token_transfer/src/lib.rs) and reflects the current implementation for Soroban SDK 22.0.0, which is pinned in [contracts/Cargo.toml](contracts/Cargo.toml).

## Overview

The token transfer contract is a thin router around a SEP-41-compatible token contract. It stores:

- the contract admin address, and
- the token contract address that should receive transfer and balance requests.

It also emits a `transfer` event for each successful transfer so that off-chain services can correlate the on-chain move with an application-level action.

## Public functions

### initialize

Signature:

```rust
pub fn initialize(env: Env, admin: Address, token_contract: Address)
```

What it does:

- Initializes the contract exactly once.
- Stores the provided `admin` in instance storage as the contract administrator.
- Stores the provided `token_contract` as the token that the contract will route transfers through.

Authorization:

- No `require_auth()` call is performed.
- The caller does not need an authorized address for this function.

Panics / failure conditions:

- Panics with `"already initialized"` if the instance storage already contains the admin key.

---

### transfer

Signature:

```rust
pub fn transfer(env: Env, from: Address, to: Address, amount: i128, memo: Bytes)
```

What it does:

- Validates the transfer amount.
- Requires the sender address to authorize the call.
- Resolves the configured token contract from instance storage.
- Delegates the actual transfer to that token contract.
- Emits a `transfer` event containing `from`, `to`, `amount`, and `memo`.

Authorization:

- The `from` address must authorize the call via `from.require_auth()`.
- The admin does not need to authorize this function.

Panics / failure conditions:

- Panics with `"amount must be positive"` when `amount <= 0`.
- Panics with `"not initialized"` if no token contract has been configured yet.
- Fails if the `from` address does not provide the required authorization.
- Can also fail or panic if the underlying token contract rejects the transfer (for example, if the sender does not have enough balance or the token contract itself aborts).

Expected on-chain effect:

- If the authorization succeeds and the underlying token contract accepts the call, the configured token contract moves `amount` tokens from `from` to `to`.
- A `transfer` event is published with the supplied metadata.

---

### balance

Signature:

```rust
pub fn balance(env: Env, address: Address) -> i128
```

What it does:

- Reads the configured token contract from instance storage.
- Queries that token contract for the balance of `address`.

Authorization:

- No `require_auth()` call is performed.
- This is a read-only query and does not require the caller to be authorized.

Panics / failure conditions:

- Panics with `"not initialized"` if the token contract has not yet been configured.
- The underlying token contract may panic or return an error if it cannot answer the balance query.

Return value:

- Returns the token balance of `address` as an `i128`.

---

### token_contract

Signature:

```rust
pub fn token_contract(env: Env) -> Address
```

What it does:

- Returns the address of the token contract currently configured for this router.

Authorization:

- No `require_auth()` call is performed.

Panics / failure conditions:

- Panics with `"not initialized"` if no token contract has been configured yet.

Return value:

- Returns the configured token contract address as an `Address`.

---

### set_token_contract

Signature:

```rust
pub fn set_token_contract(env: Env, new_token: Address)
```

What it does:

- Updates the configured token contract address to `new_token`.
- This is intended for cases such as token migrations or upgrades of the underlying token.

Authorization:

- The stored `admin` address must authorize the call via `admin.require_auth()`.

Panics / failure conditions:

- Panics with `"not initialized"` if the contract has not been initialized yet and therefore has no stored admin.
- Fails if the stored admin address does not provide the required authorization.

---

### upgrade

Signature:

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>)
```

What it does:

- Replaces the contract's current Wasm with the one identified by `new_wasm_hash`.
- This follows the standard Soroban contract upgrade pattern.

Authorization:

- The stored `admin` address must authorize the call via `admin.require_auth()`.

Panics / failure conditions:

- Panics with `"not initialized"` if the contract has not been initialized yet and therefore has no stored admin.
- Fails if the stored admin address does not provide the required authorization.
- The underlying deployment API may fail if the provided Wasm hash is invalid or cannot be installed/used for the upgrade.

---

## Worked example: a full transfer invocation

The following example shows a complete transfer call using the generated contract client.

```rust
let env = Env::default();
env.mock_all_auths();

let contract_id = env.register(TokenTransferContract, ());
let client = TokenTransferContractClient::new(&env, &contract_id);

let from = Address::generate(&env);
let to = Address::generate(&env);
let memo = Bytes::from_slice(&env, b"chat-message-42");

client.transfer(&from, &to, &500_000i128, &memo);
```

Expected effect:

1. The `from` address is checked with `require_auth()`.
2. The router resolves the configured token contract from instance storage.
3. The router calls the token contract's `transfer(from, to, 500_000)` logic.
4. The token balances of `from` and `to` are updated by the underlying token contract.
5. A `transfer` event is emitted with:
   - `from`
   - `to`
   - `amount = 500_000`
   - `memo = b"chat-message-42"`

If the call is made with `amount = 0` or a negative value, the function panics before the underlying token transfer is attempted. If the sender cannot authorize the call, the operation aborts at the auth check.
