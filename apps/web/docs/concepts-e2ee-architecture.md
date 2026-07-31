# Client-Side E2EE Crypto Stack

## Overview

The client-side E2EE crypto stack is split across two phases. **Phase 1** implements a sealed-box model using WebCrypto (ECDH + AES-GCM) for encrypting messages and files. **Phase 2** is Signal protocol groundwork — X3DH key agreement, Double Ratchet, and the `@signalapp/libsignal-client` adapter — that is not yet wired into the running application. The six modules documented below span both phases, but none of them are currently reachable from the live app's component tree; the production encryption path uses a separate set of files under `lib/crypto/`.

## Module Map

| Module | Responsibility | Phase | Status |
|---|---|---|---|
| `lib/cryptoStore.ts` | IndexedDB-backed identity key pair storage (device ID + ECDH P-256 keypair) | 1 | PARTIAL |
| `lib/prekeyStore.ts` | Prekey generation, signing, and upload (X25519 + ECDSA P-256) | 1 | PARTIAL |
| `lib/sessionStore.ts` | Session establishment (bundle fetch, X3DH key derivation, sealed-box encryption) | 1 | DEAD |
| `lib/x3dh.ts` | X3DH initiator/responder key agreement using `@noble/curves` | 2 | DEAD |
| `lib/crypto.ts` | Sealed-box encrypt, device set resolution, `sendEncryptedMessage` pipeline | 1 | PARTIAL |
| `lib/signalClient.ts` | `@signalapp/libsignal-client` stub adapter (throws on use) | 2 | DEAD |

## Crypto Stack Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  PHASE 1 (sealed-box, WebCrypto)                               │
│                                                                  │
│  cryptoStore.ts                                                  │
│    └─> stores identity keypair in IndexedDB                     │
│         │                                                        │
│         ▼                                                        │
│  prekeyStore.ts                                                  │
│    ├─> cryptoStore.ts  (identity private key for signing)      │
│    ├─> generates X25519 prekeys + signed prekey                 │
│    └─> uploads to /crypto/prekeys via apiFetch                  │
│         │                                                        │
│         ▼                                                        │
│  sessionStore.ts                                                 │
│    ├─> prekeyStore.ts  (consume one-time prekey)                │
│    ├─> fetches /crypto/bundles/:recipient/:deviceId             │
│    ├─> verifies signed-prekey signature                        │
│    ├─> SealedBoxProtocol.deriveSharedSecret (ECDH)             │
│    └─> stores session AES key in IndexedDB                     │
│         │                                                        │
│         ▼                                                        │
│  crypto.ts                                                       │
│    ├─> sealedBoxEncrypt (ECDH P-256 + AES-GCM)                 │
│    ├─> buildEnvelopes (per-device encryption)                   │
│    └─> sendEncryptedMessage (with device_set_mismatch retry)    │
│         │                                                        │
│         ▼                                                        │
│  fileEncryption.ts  (imports crypto.ts at runtime)              │
│    └─> EncryptedThumbnail.tsx  (component, type-only import)   │
│         → TYPE-ONLY import does NOT pull crypto.ts at runtime   │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  PHASE 2 (Signal protocol — NOT wired into running app)         │
│                                                                  │
│  x3dh.ts                                                          │
│    └─> @noble/curves ed25519 + x25519                           │
│    └─> initiateSession / completeSession (X3DH DH + HKDF)      │
│    └─> ONLY imported by x3dh.test.ts (test file)               │
│                                                                  │
│  signalClient.ts                                                  │
│    └─> @signalapp/libsignal-client stub (throws at runtime)    │
│    └─> ONLY dynamically imported by lib/session.ts              │
│    └─> session.ts is not imported by any running component      │
│                                                                  │
│  lib/crypto/sessionStore.ts  (in-memory session key map)       │
│    └─> Used by lib/crypto/decrypt.ts (live decryption path)    │
│    └─> DIFFERENT from lib/sessionStore.ts (documented above)   │
└──────────────────────────────────────────────────────────────────┘
```

## Module Details

### `lib/cryptoStore.ts` — `CryptoStore`

**What it does**: Manages a single IndexedDB database (`clicked_crypto`) with two object stores (`keys`, `deviceId`). Generates and persists a device identity and an ECDH P-256 identity keypair. Returns the public key for distribution and the private key for signing and key derivation.

**Key exports**: `cryptoStore` (singleton instance). Methods: `getOrCreateDeviceId`, `generateIdentityKeyPair`, `storeIdentityKeyPair`, `getIdentityPrivateKey`, `getIdentityPublicKey`, `initializeIdentityKey`, `getDeviceInfo`, `clear`, `closeDb`.

**Dependencies**: None (uses browser APIs: `indexedDB`, `window.crypto.subtle`).

**Live/dead status**: PARTIAL. The grep found two imports within `apps/web/src`:
- `lib/prekeyStore.ts:1` → `import { cryptoStore } from './cryptoStore'`
- `lib/messageCache.ts:1` → `import { cryptoStore } from './cryptoStore'`

Neither `prekeyStore.ts` nor `messageCache.ts` is imported by any component, context, or hook that runs in the application. There are no imports from `app/`, `components/`, or `hooks/`. The module's code is therefore not bundled into the running app.

---

### `lib/prekeyStore.ts` — `PrekeyStore`

**What it does**: Manages a second IndexedDB database (`clicked_prekeys`) with two object stores (`prekeys`, `signedPrekey`). Generates X25519 prekey pairs, signs the signed prekey using the identity private key from `cryptoStore`, and provides upload/replenishment methods that POST to `/crypto/prekeys` and `/crypto/prekeys/replenish`. Consumes one-time prekeys after a session is established.

**Key exports**: `prekeyStore` (singleton instance). Methods: `generateAndStoreSignedPrekey`, `generateAndStoreOneTimePrekeys`, `getSignedPrekey`, `getOneTimePrekey`, `consumeOneTimePrekey`, `getAvailableOneTimeKeysCount`, `uploadPrekeys`, `handlePrekeyLow`, `clear`, `closeDb`.

**Dependencies**: `cryptoStore` (imports `getIdentityPrivateKey`), `apiFetch` (for uploading prekeys to the server).

**Live/dead status**: PARTIAL. The grep found one import within `apps/web/src`:
- `lib/sessionStore.ts:2` → `import { prekeyStore } from './prekeyStore'`

`sessionStore.ts` itself is not imported by any component, context, or hook (see below). The chain ends at a dead module.

---

### `lib/sessionStore.ts` — `SessionStore`

**What it does**: Manages a third IndexedDB database (`clicked_sessions`). Fetches device bundles from the server, verifies the signed-prekey signature using the identity public key, derives a shared secret via ECDH (using the `SealedBoxProtocol` implementation with X25519 keys), stores the session in IndexedDB, and consumes one-time prekeys after use. Provides encrypt/decrypt methods that use the `SessionProtocol` abstraction.

**Key exports**: `sessionStore` (singleton instance), `SessionProtocol` (type alias). Methods: `fetchDeviceBundle`, `establishSession`, `getSession`, `getSessionByDeviceId`, `encryptForSession`, `decryptFromSession`, `setProtocol`, `clear`, `closeDb`.

**Dependencies**: `apiFetch` (for fetching device bundles), `prekeyStore` (for consuming one-time prekeys).

**Live/dead status**: DEAD. The grep for `from './sessionStore'` (and `from './lib/sessionStore'`) found zero imports anywhere in `apps/web/src`. Note that `lib/crypto/decrypt.ts` imports `getSessionKey` from `'./sessionStore'`, but that resolves to `lib/crypto/sessionStore.ts` (a different file), not this module.

---

### `lib/x3dh.ts` — X3DH Key Agreement

**What it does**: Implements the X3DH (Extended Triple Diffie-Hellman) session establishment protocol using `@noble/curves` (Ed25519 for identity/signing, X25519 for DH). Provides `initiateSession` (initiator side) and `completeSession` (responder side) functions, plus wire-format helpers for Ed25519 SPKI DER encoding/decoding and HKDF-based session key derivation with the Signal-spec `0xFF` prefix defense.

**Key exports**: `generateIdentityKeyPair`, `generateSignedPreKey`, `generateOneTimePreKeys`, `initiateSession`, `completeSession`, `toBase64`, `fromBase64`, `rawEd25519PublicKeyToSpki`, `spkiToRawEd25519PublicKey`, `randomBytes`. Interfaces: `IdentityKeyPair`, `PreKeyPair`, `SignedPreKeyPair`, `PreKeyBundle`, `X3dhSession`, `InitialMessageHeader`.

**Dependencies**: `@noble/curves/ed25519`, `@noble/hashes/hkdf`, `@noble/hashes/sha2`, `@noble/hashes/utils`.

**Live/dead status**: DEAD. The grep found one import within `apps/web/src`:
- `lib/x3dh.test.ts:13` → `import ... from './x3dh'`

This is a test file only. No production component, context, or hook imports this module.

---

### `lib/crypto.ts` — Sealed-Box Cryptographic Primitives

**What it does**: Implements Phase 1 sealed-box cryptography using WebCrypto. The `sealedBoxEncrypt` function derives an AES-256-GCM key via ECDH (with a fallback path using HKDF for Ed25519 SPKI keys), encrypts plaintext, and produces a wire format of `[ephemeral_pub | iv | ciphertext+tag]` all base64-encoded. Also provides `fetchConversationDevices`, `buildEnvelopes` (per-device encryption), and `sendEncryptedMessage` (with automatic `device_set_mismatch` retry, tracking issue #133).

**Key exports**: `sealedBoxEncrypt`, `fetchConversationDevices`, `buildEnvelopes`, `sendEncryptedMessage`. Types: `DeviceRecord`, `MessageEnvelope`, `SendMessageParams`.

**Dependencies**: None (uses browser APIs and `./api` indirectly through `sendEncryptedMessage`'s fetch calls).

**Live/dead status**: PARTIAL. The grep found three imports within `apps/web/src`:
- `lib/fileEncryption.ts:25` → `import { buildEnvelopes, type DeviceRecord, type MessageEnvelope } from './crypto.js'` (runtime value import)
- `lib/session.ts:19` → `import { buildEnvelopes as phase1BuildEnvelopes, sealedBoxEncrypt } from './crypto.js'` (runtime value import)
- `lib/signalClient.ts:28` → `import type { DeviceRecord, MessageEnvelope } from './crypto.js'` (type-only import)

However, `fileEncryption.ts` is only imported via a **type-only** import by `EncryptedThumbnail.tsx` (`import type { FileMessagePayload } from '@/lib/fileEncryption'`), so the runtime code of `fileEncryption.ts` (and by extension `crypto.ts`) is never pulled into the bundle. `session.ts` has runtime imports from `crypto.ts` but is itself not imported by any component, context, or hook. Therefore, `crypto.ts` is not reachable at runtime from the running app.

---

### `lib/signalClient.ts` — Signal Protocol Adapter Stub

**What it does**: A typed stub that wraps the `@signalapp/libsignal-client` WASM library behind the `SessionCrypto` interface. Both `encryptToDevice` and `buildEnvelopes` throw at runtime with a message indicating Phase 2 is not yet activated. The module is intended to be filled in when Signal integration is activated (one-liner change in `session.ts` as noted in comments). Also includes placeholder store interfaces (`SignalProtocolAddress`, `EncryptedMessage`) for a future `SignalProtocolStore` backed by IndexedDB.

**Key exports**: `SignalClient` (object with `encryptToDevice` and `buildEnvelopes` stub methods). Types: `SignalProtocolAddress`, `EncryptedMessage`.

**Dependencies**: `./crypto.js` (type-only import of `DeviceRecord`, `MessageEnvelope`).

**Live/dead status**: DEAD. The grep for static `from './signalClient'` imports found zero matches. The module is referenced only via a dynamic `await import('./signalClient.js')` inside `lib/session.ts` (lines 93, 98), which itself is not imported by any running component. No component, context, or hook in the running app references `signalClient.ts`.

---

## Phase 1 vs Phase 2

### Phase 1 — Live in the running app today

Phase 1 is the sealed-box model implemented across `cryptoStore.ts`, `prekeyStore.ts`, `sessionStore.ts`, and `crypto.ts`. These modules together provide:

1. **Identity management** (`cryptoStore.ts`): ECDH P-256 keypair generation and IndexedDB persistence per device.
2. **Prekey distribution** (`prekeyStore.ts`): X25519 prekey batch generation, ECDSA P-256 signed prekey signing, and server upload.
3. **Session establishment** (`sessionStore.ts`): Fetch device bundles, verify signed-prekey signatures, derive shared secrets via ECDH, store session keys.
4. **Message encryption** (`crypto.ts`): Sealed-box encrypt (ECDH + AES-GCM), per-device envelope assembly, and the `sendEncryptedMessage` pipeline with device-set retry.

**However**, all four Phase 1 modules are currently **not reachable** from the running app's component tree. The live decryption and encryption in production flows through a different set of files under `lib/crypto/` (specifically `lib/crypto/decrypt.ts` for inbound decryption and `lib/crypto/processEnvelope.ts` for envelope processing), which are not documented here.

### Phase 2 — Signal protocol groundwork (not yet connected)

Phase 2 is the `@signalapp/libsignal-client` integration. The groundwork is present in two modules:

1. **`x3dh.ts`**: Full X3DH key agreement using `@noble/curves` (Ed25519 + X25519) with HKDF session key derivation. Wire-format helpers for SPKI DER encoding/decoding. Only referenced by its test file — never imported by production code.
2. **`signalClient.ts`**: A stub adapter that defines the `SignalClient` object with typed but non-functional `encryptToDevice` and `buildEnvelopes` methods. Both methods throw at runtime. The dynamic import in `lib/session.ts` (which is itself dead code) is the only reference.

When Phase 2 is activated, the planned path is: install `@signalapp/libsignal-client`, fill in the stub bodies in `signalClient.ts`, and change the default session crypto implementation in `session.ts` from the Phase 1 sealed box to a `LibsignalSessionCrypto` instance.

## Dead Code / Unwired Modules

The following modules have no import path from any running component, context, or hook in `apps/web/src`:

1. **`lib/sessionStore.ts`** — DEAD. No imports found anywhere in `apps/web/src`. The `crypto/decrypt.ts` import from `'./sessionStore'` resolves to the different file `lib/crypto/sessionStore.ts`.
2. **`lib/x3dh.ts`** — DEAD. Only imported by `lib/x3dh.test.ts` (test file). Not imported by any production code.
3. **`lib/signalClient.ts`** — DEAD. No static imports found anywhere in `apps/web/src`. The only reference is a dynamic `await import('./signalClient.js')` inside `lib/session.ts`, which itself is not imported by any component.
4. **`lib/crypto.ts`** — PARTIAL (effectively DEAD at runtime). Imported by `fileEncryption.ts` (runtime), `session.ts` (runtime), and `signalClient.ts` (type-only). But `fileEncryption.ts` is only type-imported by a component, so it is tree-shaken. `session.ts` is not imported by any component. No runtime path reaches `crypto.ts`.

### Partially wired modules (imported by lib files but not reaching the app)

5. **`lib/cryptoStore.ts`** — PARTIAL. Imported by `prekeyStore.ts` and `messageCache.ts`. Neither of those files is imported by a running component.
6. **`lib/prekeyStore.ts`** — PARTIAL. Imported by `sessionStore.ts` (which itself is dead). No direct path to any component/context/hook.

## Known Gaps

1. **`crypto.ts` vs `lib/crypto/` directory**: The flat `lib/crypto.ts` file (the Phase 1 sealed-box module) is not the same as the `lib/crypto/` subdirectory used by the live app. The running decryption pipeline uses `lib/crypto/decrypt.ts` and `lib/crypto/processEnvelope.ts`, which have their own session store (`lib/crypto/sessionStore.ts`) — an in-memory `Map<string, CryptoKey>` — and do not use `lib/sessionStore.ts` at all. This is a source of confusion when grepping for `sessionStore` across the codebase.

2. **`lib/crypto/decrypt.ts` imports non-existent export**: `decrypt.ts` imports `getSessionKey` from `'./sessionStore'`, but `lib/sessionStore.ts` (the document's subject) exports `sessionStore` and `SessionProtocol`, not `getSessionKey`. The import resolves to the different file `lib/crypto/sessionStore.ts` which does export `getSessionKey`. This could cause subtle bugs if the import path is ever changed or if the two stores are conflated.

3. **`cryptoStore.ts.getIdentityPrivateKey` regenerates the key**: The method generates a fresh ECDH P-256 keypair on every call if the stored key is missing. This means if `cryptoStore.initializeIdentityKey()` has been called and the public key was stored, but `getIdentityPrivateKey` is called later, it silently generates a **new unrelated** keypair instead of returning the original private key. The private key is never persisted — this is likely a bug.

4. **`prekeyStore.ts` uses P-256 for `signPrekey` but X25519 for prekey generation**: The signed prekey signing uses ECDSA P-256 with the identity private key, but the prekeys themselves are X25519. The identity key generated in `cryptoStore.ts` is also P-256, not Ed25519. This is inconsistent with the X3DH spec in `x3dh.ts` which uses Ed25519 for identity keys and their signatures, suggesting the two code paths have different key-type assumptions.

5. **`signalClient.ts` import path uses `.js` extension**: The import in `lib/signalClient.ts` is `import type { DeviceRecord, MessageEnvelope } from './crypto.js'` (with `.js` extension), which is the Next.js convention for package-free imports but differs from the bare `'./crypto'` used in other files like `lib/crypto.ts`'s consumers (`fileEncryption.ts`, `session.ts`). This is not an error in Next.js but is inconsistent usage.

6. **No `useInboundPipeline.ts` or `useMessageHistory.ts` connection**: The live inbound message decryption in `useInboundPipeline.ts` imports from `@/lib/crypto/processEnvelope` and `@/lib/crypto/types`, not from any of the six modules documented here. The production E2EE receive path is entirely separate from the stored modules.

7. **`fileEncryption.ts` is dead code at runtime**: `EncryptedThumbnail.tsx` only imports `type { FileMessagePayload }` from `fileEncryption.ts`. Since this is a type-only import, the bundler does not include `fileEncryption.ts` (and by extension `crypto.ts`) in the runtime bundle. The `sendEncryptedFile` and `downloadAndDecryptFile` functions in `fileEncryption.ts` are effectively unreachable.