# Soroban contract client usage

This document describes how the frontend builds, signs, and submits Soroban (Stellar smart contract) invocations via the Freighter wallet, which contract functions are currently invoked and from where, and how network/RPC configuration works today.

It covers:

1. `apps/web/src/lib/soroban.ts` and `apps/web/src/lib/freighter.ts`
2. the full invocation flow: build transaction → request Freighter signature → submit → await result
3. every contract function currently invoked from the frontend and its trigger
4. network/RPC configuration

## Actors

- **User** interacting with the app in a browser with the Freighter extension installed
- **Freighter wallet** — browser extension holding the user's Stellar keypair, used to sign transactions/messages without exposing the private key to the app
- **Soroban RPC** — the Stellar RPC endpoint the frontend talks to directly to simulate and submit transactions

## Modules

### `apps/web/src/lib/freighter.ts`

Thin wrapper around `@stellar/freighter-api`:

- `requestWalletAccess(): Promise<string>` — calls Freighter's `requestAccess()`, normalizes the response (`address` or `publicKey`), and returns the connected wallet's public key, or throws if Freighter didn't return one.
- `signWalletMessage(message: string, address?: string): Promise<string>` — calls Freighter's `signMessage()`, normalizes the response (`signedMessage` or `signature`), and returns the signature string, or throws.

### `apps/web/src/lib/soroban.ts`

- `transferToken(recipient: string, amount: number|string, memo = ''): Promise<string>` (default export) — builds a `transfer(from, to, amount, memo)` invocation against the configured token-transfer contract, requests a Freighter signature, submits the signed transaction to Soroban RPC, polls until it resolves, and returns the transaction hash.

## Contract functions invoked from the frontend

| Function | Called via | Triggered from | User action |
|---|---|---|---|
| `transfer` (token-transfer contract) | `transferToken` in `lib/soroban.ts` | `components/chat/MessageInput.tsx` (`handleConfirmTransfer`) | Clicking the token icon in the chat message input to open the "Send token" popover, entering an amount, then clicking **Confirm** |
| Freighter `requestAccess` (wallet connect, not a contract call) | `requestWalletAccess` in `lib/freighter.ts` | `app/app/layout.tsx` (`handleWalletAction`) | Clicking **Connect Wallet** in the app sidebar |
| Freighter `signMessage` (message signing, not a contract call) | `signWalletMessage` in `lib/freighter.ts` | `components/treasury/ProposalCard.tsx` (`castVote`) | Clicking **Approve** or **Reject** on a treasury proposal card — signs `` `${type}:${proposalId}` `` and POSTs it to the backend for verification |

`transferToken` is currently the only function that submits an actual Soroban **contract** invocation; `requestWalletAccess`/`signWalletMessage` are Freighter wallet operations (connect / sign-message) used for wallet connection and off-chain approval signatures respectively, not contract calls.

Two other consumers exist in the codebase but are not reachable from the live app and are not part of the flow above:

- `components/wallet/WalletConnectButton.tsx` also calls `requestWalletAccess`/wallet `disconnect`, but this component is never imported or rendered anywhere — the sidebar button in `app/app/layout.tsx` duplicates the same logic inline instead.
- `contexts/AuthContext.tsx` implements a full "connect wallet → sign a challenge message → verify with backend" login flow using `signWalletMessage`, but this provider is never mounted — the root layout wires a different, unrelated `AuthProvider` (`components/auth/AuthProvider.tsx`) that has no Freighter interaction.

## Invocation flow: `transferToken`

All steps are in `apps/web/src/lib/soroban.ts`:

1. **Lazy-load dependencies** — `@stellar/freighter-api` and `stellar-sdk` are dynamically imported inside the function so the SDK stays out of the initial bundle.
2. **Resolve config** — reads `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_NETWORK_PASSPHRASE`, `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` (see [Network configuration](#network-configuration)).
3. **Check wallet connectivity** — `freighter.isConnected()`; throws if Freighter isn't installed/connected.
4. **Read the active address** — `freighter.getAddress()`.
5. **Build the contract call** — `new Contract(CONTRACT_ID)`, converts `from`/`to` to `ScVal` addresses, amount to `i128` via `BigInt`, memo to a symbol `ScVal`, then `contract.call('transfer', from, to, amount, memo)`.
6. **Fetch the source account** — `new SorobanRpc.Server(RPC_URL, { allowHttp: false })`, then `server.getAccount(publicKey)`.
7. **Build the transaction** — `TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase }).addOperation(op).setTimeout(30).build()`.
8. **Simulate** — `server.simulateTransaction(tx)`; throws on a simulation error.
9. **Assemble from simulation** — `SorobanRpc.assembleTransaction(tx, simResult).build()`, then serialize to XDR.
10. **Request Freighter signature** — `freighter.signTransaction(txXdr, { networkPassphrase })`. This is the wallet popup where the user approves/signs.
11. **Validate the signature response** — throws if Freighter returned an error or no signed XDR.
12. **Submit** — rehydrate a `Transaction` from the signed XDR and call `server.sendTransaction(signedTx)`; throws if submission itself errors.
13. **Poll for confirmation** — up to 30 attempts, 2s apart, calling `server.getTransaction(hash)`. Resolves on `SUCCESS`, throws on `FAILED`, swallows transient lookup errors mid-poll, and throws a timeout error after ~60s with no resolution.
14. **Return the transaction hash** to the caller. `MessageInput.tsx` then sends a chat message of the form `{ type: 'transfer', amount, token: 'TOKEN', txHash }`, later rendered by `TransferCard.tsx`, which links out to the Stellar Explorer for that hash.

## Network configuration

Configuration is read directly in `soroban.ts` from `NEXT_PUBLIC_*` environment variables, each with a hardcoded fallback:

| Env var | Default if unset | Used for |
|---|---|---|
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC server URL |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `Networks.TESTNET` (from `stellar-sdk`) | Network passphrase for building/signing the transaction |
| `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` | literal placeholder string `REPLACE_WITH_TOKEN_TRANSFER_CONTRACT_ID` | Contract ID passed to `new Contract(...)` |
| `NEXT_PUBLIC_NETWORK` (read separately in `components/chat/TransferCard.tsx`) | `test` | Only used to build the Stellar Explorer link, not for building/submitting the transaction |

None of these are currently listed in the root `.env.example` — that file only defines backend-facing equivalents without the `NEXT_PUBLIC_` prefix (`RPC_URL`, `TOKEN_TRANSFER_CONTRACT_ID`, `GROUP_TREASURY_CONTRACT_ID`, `PROPOSALS_CONTRACT_ID`), which are validated separately in `apps/backend/src/config.ts` and are not exposed to the browser. `next.config.ts` doesn't do anything special for the Soroban vars — Next.js exposes any `NEXT_PUBLIC_*` var automatically — but because they aren't documented anywhere in `apps/web`, it's easy to leave `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` unset and silently deploy with the placeholder contract ID. Backend and frontend contract IDs are validated independently and can point at different contracts if misconfigured.

## Implementation references

- `apps/web/src/lib/soroban.ts` — `transferToken`, build/sign/submit/poll flow
- `apps/web/src/lib/freighter.ts` — `requestWalletAccess`, `signWalletMessage`
- `apps/web/src/components/chat/MessageInput.tsx` — token-transfer UI and trigger
- `apps/web/src/app/app/layout.tsx` — wallet connect/disconnect UI and trigger
- `apps/web/src/components/treasury/ProposalCard.tsx` — proposal vote signing and trigger
- `apps/web/src/contexts/WalletContext.tsx` — wallet connection state
