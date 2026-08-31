# Treasury and wallet components

Reference for the components that surface on-chain state and initiate signed operations:

- [src/components/treasury/ProposalCard.tsx](../src/components/treasury/ProposalCard.tsx)
- [src/components/treasury/ProposeWithdrawalModal.tsx](../src/components/treasury/ProposeWithdrawalModal.tsx)
- [src/components/wallet/WalletConnectButton.tsx](../src/components/wallet/WalletConnectButton.tsx)

All three are client components (`'use client'`). For the flow-level view of how wallet auth, backend persistence, and Soroban invocation fit together, see [Wallet integration, treasury UI, and proposal flow](concepts-wallet-treasury-ui.md) and [Soroban contract client usage](api-soroban-client.md). For the on-chain semantics behind proposals and disbursement, see the contract docs cross-linked in [section 5](#5-on-chain-semantics-contract-docs).

## 1. `ProposalCard`

Renders one treasury proposal and lets the viewer cast an approve or reject vote.

### Props

| Prop       | Type                                                | Required | Description                                                                           |
| ---------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `proposal` | `Proposal`                                          | yes      | The row to render. See the shape below.                                               |
| `onVoted`  | `(id: string, vote: 'approve' \| 'reject') => void` | no       | Called after the backend accepts a vote, so the parent can refetch or patch its list. |

### Data it expects

`Proposal` is exported from the same module and mirrors what `GET /treasury/proposals` returns:

```ts
interface Proposal {
  id: string; // backend row id — used in the vote URL
  proposalId: string; // on-chain / display proposal number
  status: 'active' | 'approved' | 'rejected' | 'executed' | 'expired';
  approvalsCount: number;
  rejectionsCount: number;
  recipient: string | null;
  amount: string | null;
  token: string | null;
  threshold: number; // approvals needed
  hasVoted: boolean; // whether the current user already voted
  myVote: 'approve' | 'reject' | null;
}
```

Note the two distinct identifiers: `id` addresses the backend row (it is what the vote request is posted to), while `proposalId` is the number displayed in the header and the value that goes into the signed message.

Nullable fields render as placeholders — `recipient` becomes `—` via `truncateAddress`, and `amount`/`token` fall back to `—` and an empty string. The card never throws on an incomplete row.

`approvalsCount / threshold` drives the progress bar, clamped to 100%.

### Action it triggers: casting a vote

`castVote(type)` runs when **Approve** or **Reject** is clicked. It is **Freighter first, then the backend REST API** — both, in that order:

1. **Freighter (local signing, no chain interaction).** ``signWalletMessage(`${type}:${proposal.proposalId}`)`` from [src/lib/freighter.ts](../src/lib/freighter.ts) asks the extension to sign the string `approve:14` or `reject:14`. This is a `signMessage` call, not a transaction — nothing is submitted to Soroban and no fee is paid.
2. **Backend REST.** `POST /treasury/proposals/:id/{approve|reject}` with `{ signature }` and the bearer token from `useAuth()`. The backend verifies the signature and records the vote.

If step 1 throws, step 2 never runs — the component returns early with the toast `Freighter signing was cancelled or failed`. There is no fallback path that posts an unsigned vote.

The card does **not** call the treasury contract directly. Vote recording is off-chain in the current backend (see [Treasury API](../../backend/docs/api-treasury.md)); the contract docs describe the on-chain model the backend is designed to mirror.

### Local state and disabling

| State       | Meaning                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `voting`    | `'approve' \| 'reject' \| null` — which button is mid-flight. Buttons read `Signing…` while set. |
| `localVote` | Initialized from `proposal.myVote`; set optimistically after a successful POST.                  |

Both buttons are disabled when `proposal.hasVoted`, when `localVote` is non-null, when `proposal.status !== 'active'`, or while any vote is in flight. `voting` is cleared in a `finally`, so a failed request re-enables the buttons.

`localVote` is set only after a `res.ok`, so a rejected vote does not leave the card falsely showing a cast vote. The component does not refetch on its own — the parent page ([src/app/app/treasury/page.tsx](../src/app/app/treasury/page.tsx)) owns the list and also patches counts live from the `treasury_proposal_updated` socket event.

### Feedback

Toasts via `useToast()`: success on a recorded vote, error on a signing failure or on a non-OK response (the backend's `error` field is surfaced when present, otherwise `Failed to approve proposal` / `Failed to reject proposal`).

## 2. `ProposeWithdrawalModal`

A controlled modal form that submits a new withdrawal proposal.

### Props

| Prop        | Type         | Required | Description                                                                                                  |
| ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `isOpen`    | `boolean`    | yes      | Visibility, forwarded to [`Modal`](../src/components/ui/Modal.tsx).                                          |
| `onClose`   | `() => void` | yes      | Called on dismiss and after a successful submit.                                                             |
| `onSuccess` | `() => void` | yes      | Called after a successful submit, before `onClose` — the treasury page uses it to refetch the proposal list. |

The component is fully uncontrolled internally: the parent supplies no form values.

### Data it collects

| Field       | Control              | Validation                                                                                                     |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `amount`    | `input[type=number]` | `min="0.0000001"`, `step="any"`, required; re-checked as `parseFloat(amount) > 0` before submit                |
| `token`     | `select`             | One of `XLM`, `USDC`, `AQUA`                                                                                   |
| `recipient` | `input[type=text]`   | `/^G[A-Z2-7]{55}$/` — Stellar public-key format, checked on blur, on submit, and live once an error is showing |
| `ttl`       | `select`             | `24h`, `72h`, or `7d`                                                                                          |

The recipient regex is a format check only. It does not confirm the account exists, is funded, or has a trustline for the selected token — those are chain-side concerns; see [TTL and proposal semantics](#5-on-chain-semantics-contract-docs).

### Action it triggers: submitting a proposal

`handleSubmit` is **backend REST only — no Freighter call, no contract call, no signature**:

1. Validate `recipient`, then `amount`.
2. Read the JWT from `window.localStorage.getItem('clicked.jwt')`, guarded by a `typeof window !== 'undefined'` check.
3. `POST /treasury/propose` with `{ amount, token, recipient, ttl }` and the bearer token.
4. On success: success toast, `onSuccess()`, `onClose()`, then reset every field to its default.

Creating a proposal therefore costs nothing on-chain and requires no wallet interaction — only voting does. If the wallet is disconnected, this form still works as long as the session JWT is valid.

A non-OK response surfaces the backend's `error` field (falling back to `Failed to submit proposal`) and leaves the form populated so the user can correct and resubmit. A thrown `fetch` yields `Network error — please try again`. `loading` disables the submit button and is cleared in a `finally`.

Note that this component reads the token from `localStorage` directly rather than through `useAuth()` as `ProposalCard` does. Both resolve to the same session token; see [Auth and session contract](contracts-auth-session.md).

## 3. `WalletConnectButton`

The connect/disconnect control plus a small account menu. Takes **no props** — everything comes from `useWallet()` ([src/contexts/WalletContext.tsx](../src/contexts/WalletContext.tsx)), so it must be rendered inside a `WalletProvider` or the hook throws.

### Data it consumes

| From `useWallet()` | Type                    | Use                                                    |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| `publicKey`        | `string \| null`        | Non-null means connected; drives which branch renders. |
| `connect`          | `() => Promise<string>` | Calls `requestWalletAccess()` and stores the address.  |
| `disconnect`       | `() => void`            | Clears the cached address.                             |

### Actions it triggers

| Control               | Target                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------- |
| **Connect Wallet**    | Freighter only — `requestAccess()` via `connect()`. No backend call, no contract call. |
| **Copy address**      | `navigator.clipboard.writeText(publicKey)`, then a browser `alert`. Local only.        |
| **Edit profile**      | `router.push('/app/profile')`. Local navigation.                                       |
| **Disconnect wallet** | `disconnect()` — clears in-memory context state only.                                  |

Connecting is purely a wallet handshake: it does **not** sign a challenge and does **not** create a backend session. Wallet connection and app authentication are separate steps in this codebase — see [Auth and device lifecycle](concepts-auth-device-lifecycle.md).

Disconnecting only clears React state. Freighter still considers the site authorized, so a subsequent **Connect Wallet** typically resolves without a fresh extension prompt.

### Local state and cleanup

`isConnecting` disables the button and shows `Connecting…`; `error` renders the failure message beneath the button; `isDropdownOpen` gates the menu.

The dropdown registers `mousedown` and `keydown` (Escape) listeners on `document` while open, inside a `useEffect` keyed on `isDropdownOpen`. The cleanup removes both listeners unconditionally, so no handler outlives the component. `dropdownRef` scopes the outside-click test.

### Mounting note

This component is not currently rendered by the live app — the sidebar in [src/app/app/layout.tsx](../src/app/app/layout.tsx) duplicates the same connect logic inline. It is documented here as the canonical standalone control; see the note in [Soroban contract client usage](api-soroban-client.md).

## 4. User-visible states

These are the states a user can land in across the three components, and what each one actually does today.

### Freighter not installed

`requestWalletAccess()` calls `@stellar/freighter-api`'s `requestAccess()`. With no extension present the call rejects or returns a response with no `address`/`publicKey`, and the helper throws `Unable to read Freighter public key`.

- **`WalletConnectButton`** catches it, renders the message under the button, and clears `isConnecting`. The button stays available for a retry.
- **`ProposalCard`** catches any signing failure and shows `Freighter signing was cancelled or failed` — it does not distinguish "not installed" from "declined".
- **`ProposeWithdrawalModal`** is unaffected; it never touches the wallet.

There is no install prompt or extension-detection banner in these components. `transferToken` in [src/lib/soroban.ts](../src/lib/soroban.ts) does a real `isConnected()` probe and throws `Freighter not installed or not connected`, but that path is used by the chat token-transfer flow, not by these components.

### Not connected

`publicKey` is `null`, so `WalletConnectButton` renders the **Connect Wallet** branch.

`ProposalCard` does **not** check `publicKey` before voting. Clicking Approve on a disconnected wallet calls `signWalletMessage` anyway, which causes Freighter to surface its own connect/unlock prompt — approving there completes the flow, dismissing it produces the generic signing-failed toast. If the extension is locked, the same prompt appears.

Proposal creation works while disconnected, since it is authenticated by the session JWT rather than by the wallet.

### Wrong network

`signWalletMessage` is a message signature, not a transaction, so it carries no network passphrase and **cannot fail on a network mismatch**. Voting therefore succeeds regardless of which network Freighter is pointed at; the backend verifies the signature against the wallet's public key, which is network-independent.

Network selection matters only for actual contract submission. `transferToken` builds against `NEXT_PUBLIC_NETWORK_PASSPHRASE` (defaulting to `Networks.TESTNET`) and `NEXT_PUBLIC_SOROBAN_RPC_URL` (defaulting to the public testnet RPC). If Freighter is on a different network than the passphrase the transaction was built with, the extension rejects the signature and the error surfaces through that flow's own handling.

None of the three components documented here render a network badge or a "switch network" prompt. A user on the wrong network sees no warning until they attempt a real on-chain transfer.

### Signature rejected or cancelled

The user dismisses the Freighter prompt, or the extension rejects the request.

- **`ProposalCard`**: `signWalletMessage` rejects, the inner `try/catch` fires `Freighter signing was cancelled or failed`, `castVote` returns before any network request, and `voting` is cleared in the outer `finally`. The buttons re-enable and no vote is recorded anywhere. Retrying is safe — the whole flow re-runs from the signature.
- **`WalletConnectButton`**: a declined `requestAccess()` rejects, and the message renders under the button. `publicKey` stays `null`.

Because the signature is obtained before the POST, a rejection can never leave a half-recorded vote. The failure modes are ordered so that everything cancellable happens before anything durable.

### Backend rejects the request

For both voting and proposal creation, a non-OK response is surfaced as a toast using the backend's `error` field when present. `ProposalCard` leaves `localVote` untouched so the buttons stay live; the modal leaves the form filled. Neither component retries automatically.

## 5. On-chain semantics: contract docs

The components above are the UI surface. The rules they are surfacing — how proposals are created, approved, expire, and disburse — live in the Soroban contracts:

- [Proposal lifecycle](../../../contracts/docs/concepts-proposal-lifecycle.md) — states a proposal moves through, approval thresholds, and how expiry is decided on-chain. This is the authority for what `status`, `threshold`, and `approvalsCount` mean; `ProposalCard` only renders them.
- [Proposals API](../../../contracts/docs/api-proposals.md) — the contract entry points for creating a proposal and recording votes.
- [Token transfer flow](../../../contracts/docs/concepts-token-transfer-flow.md) and [Token transfer API](../../../contracts/docs/api-token-transfer.md) — how an approved withdrawal actually moves funds.
- [Token transfer storage](../../../contracts/docs/contracts-token-transfer-storage.md) — on-chain storage layout and TTL/rent behaviour.
- [Deployment and invocation](../../../contracts/docs/api-deployment-invocation.md) — deploying the contracts and the network/RPC configuration the frontend env vars must match.

Backend-side counterparts: [Treasury API](../../backend/docs/api-treasury.md) covers the REST endpoints these components call, including the TTL-to-ledger conversion behind the `24h` / `72h` / `7d` options in the modal, and the current off-chain-only status of vote recording.
