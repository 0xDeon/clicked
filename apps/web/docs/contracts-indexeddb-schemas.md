# Frontend IndexedDB Store Schemas

> **Purpose:** Reference inventory of every IndexedDB database the frontend opens, serving as the starting point for cache-consolidation or migration efforts.
>
> Last updated: 2026-07-30

---

## Overview

| # | DB Name | Source File | Version | Object Stores | Encryption at Rest |
|---|---------|------------|---------|---------------|---------------------|
| 1 | `clicked_crypto` | [`src/lib/cryptoStore.ts`](../src/lib/cryptoStore.ts) | 2 | 3 | ❌ (plaintext JWKs + structured-clone CryptoKey) |
| 2 | `clicked_prekeys` | [`src/lib/prekeyStore.ts`](../src/lib/prekeyStore.ts) | 1 | 2 | ❌ (plaintext JWKs) |
| 3 | `clicked_sessions` | [`src/lib/sessionStore.ts`](../src/lib/sessionStore.ts) | 1 | 1 | ❌ (plaintext JWK for AES-GCM shared secret) |
| 4 | `clicked_messages` | [`src/lib/messageCache.ts`](../src/lib/messageCache.ts) | 1 | 1 | ✅ (AES‑GCM, key derived from identity key via PBKDF2) |
| 5 | `clicked-search` | [`src/lib/search/db.ts`](../src/lib/search/db.ts) | 1 | 1 | ❌ (fully decrypted plaintext) |

---

## 1. `clicked_crypto` — Identity & Device Keys

**Source:** [`cryptoStore.ts`](../src/lib/cryptoStore.ts)  
**Version:** `2`  
**Fallback:** In-memory `Map` when `indexedDB` is unavailable (`__clickedMemoryDbs`).

### Object Store: `keys`

| Property | Value |
|----------|-------|
| Key path | *(none — inline keys)* |
| Indexes | *(none)* |

**Stored record shape** (key: `"identity_keypair"`):

```ts
interface StoredIdentityKeyPair {
  id: "identity_keypair";
  publicKey: JsonWebKey;   // ECDH P-256 public key in JWK format
  privateKey: JsonWebKey;  // ECDH P-256 private key in JWK format
  createdAt: number;       // epoch ms
}
```

**Encryption status:** ⚠️ Plaintext JWKs. The private key JWK is sensitive key material stored unencrypted at the IndexedDB level (browser's built-in storage isolation applies but no application-layer encryption).

### Object Store: `deviceId`

| Property | Value |
|----------|-------|
| Key path | *(none — inline keys)* |
| Indexes | *(none)* |

**Stored record shape** (key: `"id"`):

```ts
string // e.g. "device_lr8x2k_a3b9c1d"
```

Generated via `Math.random()` and `Date.now()` — not cryptographically random. Stored in plaintext.

### Object Store: `identityKeyPair`

Added in **version 2** migration (`event.oldVersion < 2`).

| Property | Value |
|----------|-------|
| Key path | *(none — inline keys)* |
| Indexes | *(none)* |

**Stored record shape** (key: `"current"`):

```ts
interface IdentityKeyPairRecord {
  keyPair: CryptoKeyPair;  // structured‑clone of the live CryptoKey objects
  createdAt: number;       // epoch ms
}
```

**Encryption status:** ⚠️ Structured-clone of native `CryptoKey` objects. The browser stores these as opaque handles; the actual key bytes are protected by the browser's own key store, not by application-layer encryption. The legacy `keys` store (above) holds the same key material as plaintext JWKs for backwards compatibility.

---

## 2. `clicked_prekeys` — X3DH Prekey Pool

**Source:** [`prekeyStore.ts`](../src/lib/prekeyStore.ts)  
**Version:** `1`

### Object Store: `prekeys`

| Property | Value |
|----------|-------|
| Key path | `keyId` |
| Indexes | `isOneTime` on `isOneTime` (unique: `false`) |

**Stored record shape:**

```ts
interface StoredPrekey {
  keyId: string;              // e.g. "prekey_1722441600000_a3b9c1d"
  publicKey: JsonWebKey;      // ECDH X25519 public key in JWK format
  privateKeyJwk: JsonWebKey;  // ECDH X25519 private key in JWK format (not CryptoKey)
  createdAt: number;          // epoch ms
  isOneTime: 0 | 1;           // 1 = one-time prekey, 0 = not (used for signed prekey in this store)
}
```

> **Note:** `isOneTime` is typed as `0 | 1` rather than `boolean` because IndexedDB index keys exclude booleans.

**Encryption status:** ⚠️ Plaintext JWKs. The private key material for one-time prekeys is stored as a JWK JSON object with no application-layer encryption.

### Object Store: `signedPrekey`

| Property | Value |
|----------|-------|
| Key path | *(none — inline keys)* |
| Indexes | *(none)* |

**Stored record shape** (key: `"signed"`):

```ts
interface SignedPrekeyRecord {
  keyId: string;              // e.g. "prekey_1722441600000_a3b9c1d"
  publicKey: JsonWebKey;      // ECDH X25519 public key in JWK format
  privateKeyJwk: JsonWebKey;  // ECDH X25519 private key in JWK format
  createdAt: number;          // epoch ms
  isOneTime: 0;               // always 0 for signed prekey
}
```

**Encryption status:** ⚠️ Plaintext JWK. The signed prekey private key is stored unencrypted.

---

## 3. `clicked_sessions` — E2EE Session Store

**Source:** [`sessionStore.ts`](../src/lib/sessionStore.ts)  
**Version:** `1`  
**Fallback:** In-memory `Map` when `indexedDB` is unavailable (`__clickedMemoryDbs`).

### Object Store: `sessions`

| Property | Value |
|----------|-------|
| Key path | `sessionId` |
| Indexes | `deviceId` on `deviceId` (unique: `true` — one session per device) |

**Stored record shape:**

```ts
interface CachedSession {
  sessionId: string;          // e.g. "session_1722441600000_a3b9c1d"
  deviceId: string;           // the remote device this session is with
  sharedSecretJwk: JsonWebKey;// AES-GCM shared secret in JWK format
  createdAt: number;          // epoch ms
}
```

**Encryption status:** ⚠️ Plaintext JWK. The AES-GCM shared secret used to encrypt/decrypt messages is stored as a JWK with no application-layer encryption. Anyone with access to IndexedDB can retrieve the session key.

---

## 4. `clicked_messages` — Encrypted Message Cache

**Source:** [`messageCache.ts`](../src/lib/messageCache.ts)  
**Version:** `1`

### Object Store: `messages`

| Property | Value |
|----------|-------|
| Key path | `id` |
| Indexes | `conversationId` on `conversationId` (unique: `false`), `timestamp` on `timestamp` (unique: `false`) |

**Stored record shape:**

```ts
interface CachedMessage {
  id: string;              // message UUID
  conversationId: string;  // conversation UUID
  content: string;         // ⚠️ ALWAYS EMPTY at rest — the real content is encrypted
  senderId: string;        // ⚠️ ALWAYS EMPTY at rest — encrypted
  timestamp: number;       // epoch ms — stored in plaintext
  iv: string;              // AES-GCM initialization vector (hex)
  encryptedContent: string;// AES-GCM ciphertext (hex) containing { content, senderId }
}
```

**Encryption scheme:**
1. Derive a 256-bit AES-GCM key via PBKDF2 (SHA-256, 100k iterations) from the identity public key JWK, salted with `"clicked_cache_salt"`.
2. On write: serialize `{ content, senderId }` as JSON, encrypt with AES-GCM, store ciphertext in `encryptedContent` along with the random IV in `iv`.
3. On read: decrypt `encryptedContent` with the cached key and parse the JSON.

**Encryption status:** ✅ Encrypted at rest. Message content and sender identity are stored as AES-GCM ciphertext. However:
- `id`, `conversationId`, and `timestamp` remain in plaintext (leaking conversation membership and timing metadata).
- The encryption key is derived from the identity public key (which is itself stored in plaintext in `clicked_crypto`), so the encryption is only as strong as the identity key's secrecy.


> **⚠️ Subtle bug note:** The `CachedMessage` interface declares `content` and `senderId` as `string` fields, and the `addMessage` method spreads the input message (which includes `content`/`senderId`) into the stored object alongside `iv`/`encryptedContent`. This means the plaintext `content` and `senderId` are **also written to IndexedDB in the clear** alongside the ciphertext. The `getMessage` path relies on decryption, but the raw record still contains the plaintext duplicates in the DB.

---

## 5. `clicked-search` — Local Full-Text Search Index

**Source:** [`search/db.ts`](../src/lib/search/db.ts)  
**Version:** `1`  
**Library:** Uses [`idb`](https://github.com/jakearchibald/idb) (promise-based IndexedDB wrapper) instead of raw `indexedDB`.

### Object Store: `messages`

| Property | Value |
|----------|-------|
| Key path | `id` |
| Indexes | `conversationId` on `conversationId` (unique: `false`), `createdAt` on `createdAt` (unique: `false`), `conversation_created` compound on `["conversationId", "createdAt"]` (unique: `false`) |

**Stored record shape** (from [`types.ts`](../src/lib/search/types.ts)):

```ts
interface DecryptedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  plaintext: string;          // fully decrypted message body
  contentType: string;
  createdAt: string;          // ISO 8601
  sequenceNumber?: number | null;
}
```

**Encryption status:** ⚠️ **Plaintext.** This database stores fully decrypted messages for local full-text search (issue #185 — server cannot search ciphertext). Every field including `plaintext` is stored without any encryption. This is by design since search requires plaintext access, but it means this database contains all message content in the clear.

---

## Encryption Summary

| DB | Sensitive Data Stored | Protected? |
|----|----------------------|------------|
| `clicked_crypto` | Identity private key (JWK), CryptoKey handles | ❌ JWKs in plaintext; CryptoKey handles rely on browser key store |
| `clicked_prekeys` | Prekey private keys (JWK) | ❌ Plaintext JWKs |
| `clicked_sessions` | AES-GCM session shared secrets (JWK) | ❌ Plaintext JWKs |
| `clicked_messages` | Message content + sender ID | ✅ AES-GCM encrypted (but see plaintext-duplicate caveat above) |
| `clicked-search` | Fully decrypted message plaintext | ❌ No encryption at all |

All databases rely on the browser's same-origin storage isolation for baseline protection. No database uses [WebCrypto non-extractable keys](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey#extractable) or application-level key-wrapping beyond `clicked_messages`' PBKDF2-derived AES-GCM.

---

## Cache-Consolidation Notes

- `clicked-search` and `clicked_messages` both store messages indexed by `conversationId` + time but with different shapes (decrypted vs. encrypted) — a consolidation could merge them into a single store where the search index reads from the decrypted cache.
- `clicked_crypto`, `clicked_prekeys`, and `clicked_sessions` all hold E2EE key material in plaintext JWK format and could benefit from a unified, encrypted key store.
- The `clicked_crypto` v2 migration added `identityKeyPair` alongside the legacy `keys` store; once all clients are on v2+, the legacy store can be removed.
- `clicked_messages` has a potential plaintext-leak bug where `content`/`senderId` are stored both in the clear and encrypted in the same record.
