# Threat Model (#394)

Scope: the `apps/backend` gateway/API and its data stores (Postgres, Redis,
S3-compatible object storage). Client-side crypto correctness is covered by
[`signal-integration.md`](./signal-integration.md); this doc is about what
the *server* can see and do, not whether the ratchet math is sound.

## What the server can see

| Data | Server visibility | Why |
|---|---|---|
| Message ciphertext | Opaque bytes only | `validateMessagePayload` (`apps/backend/src/lib/validateMessagePayload.ts`) requires ciphertext to travel inside per-device `envelopes`; the server stores and relays it without decrypting |
| Per-recipient envelopes | Opaque bytes only | Same as above — one envelope per recipient device, keyed by `recipientDeviceId` |
| Sender/recipient identity | Plaintext | `senderId`, `senderDeviceId`, `conversationId`, `recipientDeviceId` are unencrypted — the server must know routing to deliver |
| Conversation membership | Plaintext | `conversation_members` table — the server knows who is in which conversation |
| Message timing | Plaintext | `createdAt`, delivery timestamps, presence timestamps are all server-visible |
| Message size | Plaintext (approx.) | Ciphertext length is visible even though content isn't; file sizes are visible via `files`/object storage |
| Content type | Plaintext | `contentType` (`text`/`file`/`image`/`video`/`audio`) is an unencrypted enum field, not covered by the ciphertext guard |
| Presence (online/offline) | Plaintext | Redis presence hashes; gated by `presenceVisible` user setting but visible to the server regardless |
| Push subscription endpoints | Plaintext | Web Push endpoints stored in `push_subscriptions`; the push provider (browser vendor) also sees delivery metadata |
| Device identity public keys, signed prekeys, one-time prekeys | Plaintext (public keys) | Public by design — this is how X3DH/session bootstrap works. Private keys never leave the client (see below) |
| Wallet address | Plaintext | Used for Stellar-based auth; stored on `wallets` |

## What the server cannot see

- **Message plaintext.** No code path accepts a plaintext message body — enforced by `validateMessagePayload` and regression-tested in `apps/backend/src/__tests__/security.regression.test.ts` (#388).
- **Private keys.** Identity private keys, signed-prekey private keys, and one-time-prekey private keys are generated and held client-side only; the backend schema has no field capable of storing them (also regression-tested — the field-name scan in #388 fails CI if one is ever added).
- **Session/ratchet state.** Signal session state (root key, chain keys, ratchet state) lives entirely on the client. The backend never stores or transmits it.
- **File contents.** Uploaded files are encrypted client-side before upload (envelopes carry the encrypted file key); the object store holds ciphertext blobs only.

## Residual metadata risk

Even with content, keys, and session state fully opaque to the server, the
following metadata is inherent to operating a centralized delivery service
and is **not** mitigated by the current architecture:

1. **Social graph.** Conversation membership reveals who talks to whom, independent of what's said.
2. **Traffic analysis.** Message timing and size (ciphertext length) can leak coarse signals (e.g., a burst of large messages suggests a file share) even without decrypting content.
3. **Presence/activity patterns.** Online/offline transitions and heartbeat timing reveal usage patterns unless a user disables `presenceVisible`.
4. **Device fingerprinting.** `deviceName`, `platform`, and prekey consumption rate are visible per device and could be correlated across sessions.
5. **Push metadata.** Web Push delivery goes through the browser vendor's push service (Google/Mozilla/Apple infrastructure), which sees endpoint + timing even though the payload is content-free (`services/pushNotification.ts` sends only `{ type, conversationId, messageId, count }` — no ciphertext, but `conversationId`/`messageId` are still visible to the push provider).
6. **IP addresses.** Standard for any centralized WebSocket/HTTP service; not masked by this architecture (a client-side concern — Tor/VPN if required).
7. **No forward secrecy in Phase-1 crypto.** Per `signal-integration.md`, the currently-active `Phase1SessionCrypto` is a sealed-box (ECDH + HKDF + AES-256-GCM) with **no ratchet** — compromise of a device's long-term key retroactively decrypts all past ciphertext an attacker recorded. This is a client-crypto property, not a server-visibility one, but it changes what "the server was breached" means: a breached server that had been passively logging ciphertext, combined with a later client key compromise, decrypts history. Phase-2 (`LibsignalSessionCrypto`, full Double Ratchet) closes this gap once activated.

## Trust boundary summary

```
┌─────────────┐   ciphertext only   ┌─────────────┐   ciphertext only   ┌─────────────┐
│ Sender      │ ──────────────────► │ Backend      │ ──────────────────► │ Recipient   │
│ device      │                     │ (routes,     │                     │ device      │
│             │ ◄────────────────── │  socket      │ ◄────────────────── │             │
└─────────────┘  plaintext routing  │  gateway,    │  plaintext routing  └─────────────┘
                  metadata only     │  Postgres,   │  metadata only
                                    │  Redis, S3)  │
                                    └─────────────┘
```

The backend is a trusted router for metadata and an untrusted (blind) relay
for content. A full server compromise exposes everything in the "server can
see" table above, plus historical ciphertext (which is only a plaintext
risk if combined with a subsequent private-key compromise, per the
forward-secrecy caveat above) — but never plaintext message content on its
own.

Cross-referenced from [`IMPLEMENTATION_DOCS.md`](../IMPLEMENTATION_DOCS.md).
See also: [`runbook.md`](./runbook.md) for incident response when this
boundary is suspected to have been crossed (key-drain scenario).
