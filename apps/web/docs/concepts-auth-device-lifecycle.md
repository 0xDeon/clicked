# Concepts: Auth & Device Identity Lifecycle

This document explains the frontend authentication and device identity lifecycle in Clicked, specifically focusing on how `AuthContext.tsx`, `lib/jwt.ts`, and `lib/deviceIdentity.ts` work together to create a device-bound session model required by the backend.

## Overview
Clicked uses a device-bound session model where authentication is tied not just to a user's wallet address, but also to a specific cryptographic device identity generated on the client. 

This is orchestrated by three main files:
1. **`lib/deviceIdentity.ts`**: Manages the local cryptographic identity (Ed25519 keypair) and a persistent `deviceId`.
2. **`contexts/AuthContext.tsx`**: Orchestrates the wallet connection, signature challenge, and session state.
3. **`lib/jwt.ts`**: Handles the JWT payload parsing and device ID syncing for End-to-End Encryption (E2EE).

---

## First-Run Flow (New Device / Login)

When a user logs in on a new device, the following step-by-step flow occurs:

1. **Connect Wallet**: 
   The user initiates login via `AuthContext.tsx` (`signIn()`). It checks for an existing public key or prompts the user to connect their wallet using `useWallet()`.

2. **Establish Device Identity**: 
   Before requesting a challenge, `getOrCreateDeviceIdentity()` is called from `lib/deviceIdentity.ts`. 
   - If no identity exists, it generates a new Ed25519 keypair and a random UUID (`deviceId`), saving both in `localStorage`.
   - It returns the `deviceId` and the Base64-encoded `identityPublicKey`.

3. **Sign Challenge**:
   `AuthContext.tsx` makes a `POST /auth/challenge` request to the backend with the `walletAddress`.
   The backend returns a `message` and a `nonce`. The user is prompted to sign the `message` using their wallet (`signWalletMessage`).

4. **Verify & Bind**:
   The frontend sends the signature back to the backend via `POST /auth/verify`. Crucially, this request includes:
   - `walletAddress`
   - `signature`
   - `nonce`
   - `identityPublicKey` (from the device identity)
   
   The backend verifies the signature and binds the new session to the `identityPublicKey`.

5. **Receive JWT**:
   Upon success, the backend returns a JWT (`token`) and potentially a synchronized `deviceId`. 
   The token is persisted in `localStorage` across multiple keys (for compatibility/redundancy) by `AuthContext.tsx`. The JWT payload contains the `userId`, `walletAddress`, and `deviceId`.

---

## Returning-User Flow (Existing Session)

When a user returns with an active session:

1. **Load Session**:
   On initialization, `AuthContext.tsx` runs a `useEffect` that checks for an existing token via `readToken()`.

2. **Parse JWT**:
   If a token is found, it calls `parseJwtUser(token)`, which uses `parseJwtClaims` (re-exporting logic related to `lib/jwt.ts`). It extracts the `userId`, `walletAddress`, and `deviceId` directly from the token payload without needing a network request.

3. **Device Identity Retrieval**:
   The cryptographic keys and device ID remain in `localStorage` (managed by `lib/deviceIdentity.ts`). Subsequent authenticated API requests implicitly rely on this established JWT. If E2EE or realtime features are used, `lib/jwt.ts` helps sync the `deviceId` via `getE2EDeviceId(token)`.

---

## The Device-Bound Session Model

By tying the JWT to a specific `deviceId` and `identityPublicKey`, the application achieves a **device-bound session**. 
- **`lib/jwt.ts`** enforces that the frontend can read its `deviceId` from the token and sync it to the `clicked.e2eDeviceId` storage key.
- The backend can reject requests if a token is used from a device that doesn't hold the corresponding private key for the `identityPublicKey` (used in End-to-End Encryption features).
- This prevents token-theft attacks: stealing the JWT is insufficient if the attacker cannot also steal the local `localStorage` Ed25519 private key.

*Note: For details on how the backend validates these tokens and binds them to the device identity, refer to the Backend JWT/Auth Contract Documentation.*
