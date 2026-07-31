# Wallet integration, treasury UI, and proposal flow

This note documents how the web app combines wallet auth, backend persistence, and direct Soroban contract interaction for treasury and proposal workflows.

## 1. Wallet connection and signing

The wallet layer is implemented in [src/contexts/WalletContext.tsx](../src/contexts/WalletContext.tsx) and [src/lib/freighter.ts](../src/lib/freighter.ts).

### WalletContext

The React context exposes three pieces of state and behavior:

- `publicKey`: the currently connected wallet address, exposed to UI consumers.
- `connect()`: requests wallet access from Freighter, stores the returned public key in context, and returns it to the caller.
- `disconnect()`: clears the cached public key so the UI stops presenting the wallet as connected.

In practice this is the small client-side bridge between the browser wallet and the rest of the app. The UI uses it to know whether a user is connected before attempting wallet-specific flows.

### Freighter bridge

The Freighter helper wraps the browser wallet API:

- `requestWalletAccess()` calls Freighter’s access API, reads the public key from the response, and throws if no usable address is returned.
- `signWalletMessage(message, address?)` asks Freighter to sign a message and returns the signature payload, accepting an optional address to scope the request.

The treasury and proposal UI uses this signing step when a user needs to prove ownership of a wallet address or create a signed vote payload before sending the result to the backend.

## 2. Treasury UI: backend REST vs direct contract calls

The treasury experience lives in [src/app/app/treasury/page.tsx](../src/app/app/treasury/page.tsx) and the related components in [src/components/treasury/ProposeWithdrawalModal.tsx](../src/components/treasury/ProposeWithdrawalModal.tsx) and [src/components/treasury/ProposalCard.tsx](../src/components/treasury/ProposalCard.tsx).

### User actions and where they go

| UI action | First step | Second step | Notes |
| --- | --- | --- | --- |
| Open treasury page | Backend REST: `GET /treasury/proposals` | None | The page fetches proposal rows from the backend and renders them in the UI. |
| Create a withdrawal proposal | Backend REST: `POST /treasury/propose` | None | The modal sends the proposal payload to the backend, which stores the proposal metadata and returns the draft row. |
| Approve a proposal | Wallet signing via Freighter | Backend REST: `POST /treasury/proposals/:id/approve` | The UI first asks Freighter to sign a message based on the proposal id, then posts the signature to the backend. |
| Reject a proposal | Wallet signing via Freighter | Backend REST: `POST /treasury/proposals/:id/reject` | Same pattern as approve: sign locally, then send the signature to the backend. |

The current UI does not call Soroban contracts directly from these treasury actions. Instead, the web app uses the backend REST layer as the authoritative entry point for proposal creation and voting metadata. The backend is responsible for persisting proposal rows, vote records, and the user-visible state that feeds the UI.

### Where the on-chain semantics live

The treasury UI is intentionally separated from contract execution details. The backend listens for contract events and updates proposal state in its own database. For the actual on-chain semantics, see the contracts app docs in [../../contracts/README.md](../../contracts/README.md) and the contract implementations in [../../contracts/contracts/group_treasury/src/lib.rs](../../contracts/contracts/group_treasury/src/lib.rs) and [../../contracts/contracts/proposals/src/lib.rs](../../contracts/contracts/proposals/src/lib.rs).

## 3. Proposal page: current UI composition

The proposal page in [src/app/app/proposals/page.tsx](../src/app/app/proposals/page.tsx) is currently a local, client-side experience. It does not yet call the backend or Soroban directly; it uses local component state to render example proposal cards and update vote totals when a user clicks the vote buttons.

That means the current proposal page is a UI-only mock rather than a full end-to-end treasury/proposal integration.

## 4. How the app is intended to fit together

The intended architecture is:

1. The web UI uses the backend REST API for application-level workflow state, auth, and proposal persistence.
2. The wallet layer signs messages in the browser with Freighter when a user approves or rejects a proposal.
3. The backend and the Soroban contracts share responsibility for the real on-chain lifecycle of proposals and treasury withdrawals.
4. The contracts app remains the source of truth for on-chain semantics such as proposal expiry, approval thresholds, vote tallying, and execution rules.

## 5. Cross-reference to the contracts app

For the on-chain behavior behind the UI, read:

- [../../contracts/contracts/group_treasury/src/lib.rs](../../contracts/contracts/group_treasury/src/lib.rs) for the group treasury contract and its proposal lifecycle.
- [../../contracts/contracts/proposals/src/lib.rs](../../contracts/contracts/proposals/src/lib.rs) for proposal creation, vote casting, finalization, and execution semantics.
- [../../contracts/README.md](../../contracts/README.md) for the broader Soroban project context.
