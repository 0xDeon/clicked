# Token Transfer Contract — Storage Layout and Token Interface

## Overview

The `token_transfer` contract is a Soroban smart contract that routes token transfers through a configured SEP-41 token contract. It stores minimal state — an admin address and the address of the token contract — in instance storage, and exposes `transfer`, `balance`, `token_contract`, `set_token_contract`, and `upgrade` operations. This document covers the contract's storage keys, their types, the Soroban storage types used, the token interface trait that external token contracts must implement, and known gaps in the codebase.

## Storage Keys

| Key Name | Storage Type | Value Type | Description |
|---|---|---|---|
| `DataKey::TokenContract` | Instance | `Address` | The SEP-41 token contract this transfer contract operates on |
| `DataKey::Admin` | Instance | `Address` | Admin address allowed to update the token contract |

Both keys are defined in `storage.rs` as variants of the `DataKey` enum, which is annotated with `#[contracttype]`. All storage reads and writes in `lib.rs` use `env.storage().instance()`, confirming these are instance-scoped keys.

The `TransferEvent` struct in `storage.rs` is not a storage key; it is a data structure used for event emission after successful transfers. Its fields are: `from` (`Address`), `to` (`Address`), `amount` (`i128`), and `memo` (`soroban_sdk::Bytes`).

## Storage Type Usage

This contract uses **only Instance storage** (`env.storage().instance()`). No Persistent or Temporary storage is used.

- **Instance storage** is scoped to the contract instance and persists for the lifetime of the contract on the ledger. It has no TTL and is not subject to rent eviction. This is appropriate for the contract's needs because the admin address and token contract address are long-lived configuration values that must survive across transactions.
- **Persistent storage** (`env.storage().persistent()`) is not used. Persistent storage has a TTL and is subject to rent charges; it would be appropriate for per-user or per-asset data that needs expiration, but this contract does not store per-user state.
- **Temporary storage** (`env.storage().temporary()`) is not used. Temporary storage is volatile and only persists within a single transaction; it is suitable for intermediate computation results, which this contract does not need.

Because all state fits in instance storage, the contract incurs no ongoing storage rent costs and its data is permanent as long as the contract exists on the ledger.

## Token Interface

The token interface is defined in `token_interface.rs` as a Soroban contract client trait (`#[contractclient(name = "TokenClient")]`). It declares two methods that external token contracts must implement for this contract to interact with them.

### `transfer`

- **Signature:** `fn transfer(env: Env, from: Address, to: Address, amount: i128)`
- **Purpose:** Initiates a token transfer of `amount` from `from` to `to` on the token contract.
- **Inputs:** `env` (the Soroban environment), `from` (source address), `to` (destination address), `amount` (integer amount, must be positive).
- **Outputs:** None (void return). The contract does not propagate or check the result of this call.
- **Compatibility requirement:** The target token contract must implement this exact method signature so that `TokenClient::new(&env, &token_id).transfer(&from, &to, &amount)` can be invoked.

### `balance`

- **Signature:** `fn balance(env: Env, id: Address) -> i128`
- **Purpose:** Returns the token balance of address `id`.
- **Inputs:** `env` (the Soroban environment), `id` (the address whose balance is queried).
- **Outputs:** `i128` — the token balance of the given address.
- **Compatibility requirement:** The target token contract must implement this exact method signature so that `TokenClient::new(&env, &token_id).balance(&address)` can be invoked.

## Token Compatibility

This contract is designed for **Stellar Asset Contract (SAC) / SEP-41 tokens**. The comment in `token_interface.rs` explicitly states: "Minimal SEP-41 token interface used to invoke external token contracts."

For a token contract to be compatible with `token_transfer`, it must implement the `TokenInterface` trait with exactly these two methods:

1. `fn transfer(env: Env, from: Address, to: Address, amount: i128)` — must accept a `from` address that has already been authorized (the contract calls `from.require_auth()` before invoking `transfer`).
2. `fn balance(env: Env, id: Address) -> i128` — must return the token balance for the given address.

The contract does not require `approve`, `decrease_approval`, or any other SAC-specific methods. It assumes the token contract's `transfer` method will enforce its own authorization and balance checks. The contract does not inspect or validate the result of `token.transfer()`, so a token contract that silently fails or reverts will propagate that failure to the caller via Soroban's host function error handling.

## Known Gaps

- **No error module:** `error.rs` does not exist in the `token_transfer` source. The contract uses `panic!` for error conditions (e.g., "already initialized", "not initialized", "amount must be positive") rather than returning structured Soroban errors. This means callers receive host-level panic errors rather than typed error codes.
- **No `types.rs`:** The file `types.rs` does not exist. Custom types like `TransferEvent` are defined directly in `storage.rs`.
- **`TokenInterface::transfer` returns void:** The token interface's `transfer` method has no return type. The contract's `transfer` function does not check whether the underlying token transfer succeeded; if the token contract reverts, the Soroban host will abort the transaction, but a silent failure (if the token contract swallows errors) would go undetected.
- **No balance pre-check:** The `transfer` function does not verify that `from` has sufficient balance before calling `token.transfer()`. It relies entirely on the token contract to reject insufficient-balance transfers.
- **`TransferEvent.memo` is unbounded `Bytes`:** The memo field in `TransferEvent` is typed as `soroban_sdk::Bytes` with no documented length limit. Large memos could increase event size and impact ledger footprint.
- **`TransferEvent` is not a storage key:** Although defined in `storage.rs`, `TransferEvent` is not part of the `DataKey` enum and is only used for event emission. It does not consume persistent or instance storage slots.