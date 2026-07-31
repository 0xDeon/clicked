# Token transfer flow & Stellar asset handling

## What "token" means in this contract

The `token_transfer` contract (`contracts/contracts/token_transfer/`) is a thin routing layer over any **SEP-41** compliant token contract. SEP-41 is Soroban's standard token interface (analogous to ERC-20 on EVM chains) that exposes at least `transfer(env, from, to, amount)` and `balance(env, id)`.

The token contract it routes through can be one of two things:

| Kind | Description |
|---|---|
| **Stellar Asset Contract (SAC)** | Soroban's built-in wrapper that bridges a Stellar Classic asset (a `(issuer, code)` pair such as `USDC:GA5Z...)` into a SEP-41 contract address. Every Classic asset has a deterministic SAC address derived from its issuer + code. SAC is the most common backing token. |
| **Custom SEP-41 token** | Any user-deployed Soroban contract that implements the SEP-41 interface (e.g. a mintable token, a governance token, a wrapped bridge token). |

The `token_transfer` contract is agnostic to which kind backs it — it calls `transfer` and `balance` through the `TokenClient` binding (`contracts/contracts/token_transfer/src/token_interface.rs`) and never inspects the underlying implementation.

### `set_token_contract` — re-targeting the router

```rust
pub fn set_token_contract(env: Env, new_token: Address)  // lib.rs:80
```

Admin-only. Swaps the stored `TokenContract` address to `new_token`. This is used for:

- **Token migrations** — if the group switches from one asset to another (e.g. from a wrapped bridge token to native SAC-wrapped USDC).
- **Reconfiguration** — pointing the contract at a different SAC address after a protocol upgrade.

Caller must authenticate as the `Admin` address set during `initialize`.

---

## End-to-end: one transfer traced

```
┌────────────────────────────────────────────────────────────────┐
│  Client (frontend)                                             │
│  calls token_transfer::transfer(from, to, amount, memo)        │
│  e.g. memo = hex-encoded chat-message UUID                     │
└─────────────┬──────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────┐
│  On-chain: token_transfer contract                             │
│                                                               │
│  1. Validates amount > 0                                       │
│  2. from.require_auth() — sender must sign the tx             │
│  3. Reads TokenContract address from storage                   │
│  4. Calls token.transfer(&from, &to, &amount) on the          │
│     underlying SEP-41 token (SAC or custom)                    │
│  5. Emits contract event:                                      │
│       topic:   ("transfer",)                                   │
│       data:    TransferEvent { from, to, amount, memo }        │
│                                                               │
│  *If the underlying token is SAC, step 4 also settles the      │
│   balance in the Stellar Classic asset — the SAC contract      │
│   converts the SEP-41 call into a trustline/balance operation  │
│   on the Classic side transparently.*                          │
└─────────────┬──────────────────────────────────────────────────┘
              │
              │  Soroban RPC (getEvents)
              ▼
┌────────────────────────────────────────────────────────────────┐
│  Off-chain: stellarListener.ts                                 │
│  (apps/backend/src/services/stellarListener.ts)                │
│                                                               │
│  1. Polls Soroban RPC getEvents for topic "transfer" on the   │
│     configured token_transfer contractId (every ~5 s)          │
│  2. Filters events with valid txHash / from / to / amount      │
│  3. For each event, calls defaultPersistEvent():               │
│                                                               │
│     a. Decodes memoHex → UTF-8 string                         │
│     b. If the decoded string is a valid UUID v4:               │
│        - Looks up messages.id matching that UUID               │
│        - Extracts conversationId + senderId from the message   │
│     c. Falls back to the first conversation/first user in DB   │
│        if no matching message is found                         │
│     d. Upserts into the token_transfers table:                 │
│        ON CONFLICT (tx_hash) DO UPDATE set createdAt = now()  │
│                                                               │
│  4. Cursor advances only on successful persist (no re-read)    │
│  5. On transient failure: exponential backoff (1 s → 30 s)    │
│  6. Errors are logged but never rethrown — server stays up     │
└─────────────┬──────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────┐
│  Database: token_transfers table                               │
│  (apps/backend/src/db/schema.ts:249-269)                       │
│                                                               │
│  Column              Type              Purpose                 │
│  ────────────────────────────────────────────────────────────  │
│  id                  uuid              PK, auto-generated      │
│  tx_hash             text (unique)     Soroban transaction hash│
│  conversation_id     uuid (FK→convs)   Chat conversation       │
│  sender_id           uuid (FK→users)   User who initiated      │
│  recipient_address   text              Stellar dest address    │
│  amount              text              Decimal string (i128)   │
│  token_contract_id   text              SEP-41 contract address │
│  memo                text (nullable)   Hex-encoded memo bytes  │
│  created_at          timestamp         Row creation time       │
│                                                               │
│  See schema.ts:249-269 for the full Drizzle ORM definition.    │
└─────────────┬──────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────┐
│  Frontend / user                                               │
│                                                               │
│  1. Client fetches rows from token_transfers filtered by       │
│     conversation_id to render a payment-history UI             │
│  2. Each row shows: who sent, who received, how much, when     │
│  3. The frontend can correlate the transfer back to the        │
│     original chat message via the memo UUID                    │
└────────────────────────────────────────────────────────────────┘
```

## Idempotency guarantees

- **On-chain**: The contract emits exactly one `TransferEvent` per successful `transfer` call. If the underlying token transfer fails (e.g. insufficient balance), the entire call reverts and no event is emitted.
- **Listener**: `runForever` uses cursor-based pagination and only advances the cursor per-event after `persistEvent` resolves. If persist throws, the same event is re-read on the next poll.
- **Database**: `tokenTransfers.tx_hash` has a `UNIQUE` constraint. The upsert (`ON CONFLICT DO UPDATE`) means re-processing the same event simply bumps `created_at` — no duplicate rows.

## Cross-references

- Contract source: `contracts/contracts/token_transfer/src/lib.rs`
- Token interface binding: `contracts/contracts/token_transfer/src/token_interface.rs`
- Storage & event types: `contracts/contracts/token_transfer/src/storage.rs`
- Backend listener: `apps/backend/src/services/stellarListener.ts`
- Database schema (tokenTransfers table): `apps/backend/src/db/schema.ts:249-269`
- Listener tests: `apps/backend/src/__tests__/stellarListener.test.ts`
- Contract tests: `contracts/contracts/token_transfer/src/test.rs`

## Related issues

- **#46** — Token transfer contract & listener (original implementation)
- **#130** — Group treasury multisig (extends the same listener pattern)
- **#44** — Contract upgrade mechanism (`upgrade` fn in `lib.rs`)
