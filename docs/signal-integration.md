# Signal Protocol Integration — Library Evaluation & Decision

## Decision

**Selected library:** [`@signalapp/libsignal-client`](https://github.com/signalapp/libsignal)

**Status:** Phase-2 interface wired; implementation stub in `signalClient.ts`.  
Activation requires filling in the stub and changing `defaultSession` in `session.ts`.

---

## Evaluation

### Candidates considered

| Library | Maintained by | WASM/native | Audit | Bundle size (gzipped) |
|---|---|---|---|---|
| **@signalapp/libsignal-client** | Signal Foundation | WASM + Node native | ✅ Audited by Cure53 (2016, 2019, 2022) | ~1.2 MB raw / ~380 KB gzip |
| libsignal-protocol-javascript | Open Whisper Systems (archived) | Pure JS | ❌ Unmaintained (last commit 2021) | ~80 KB |
| @privacyresearch/libsignal-protocol-typescript | Community | Pure JS | ❌ No independent audit | ~120 KB |

### Why `@signalapp/libsignal-client`

1. **Actively maintained** by the Signal Foundation — the same team that maintains the Signal Messenger clients.
2. **Independently audited** by Cure53:
   - [2016 audit](https://cure53.de/pentest-report_signal-android.pdf) (Android / OWS)
   - [2019 audit](https://github.com/signalapp/Signal-Desktop/blob/main/docs/Cure53%20Security%20Audit.pdf) (Desktop)
   - [2022 audit](https://community.signalusers.org/t/security-audit-of-the-signal-protocol/29973) (Protocol layer)
3. **Full Double-Ratchet + X3DH** — not a partial implementation.
4. **WASM build** — runs in modern browsers; Node native build for server-side tests.
5. **TypeScript types** — ships first-class `.d.ts`.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| WASM ~380 KB gzip adds to initial bundle | Loaded via dynamic import in `LibsignalSessionCrypto` — deferred until first send |
| SSR incompatibility (Next.js) | Dynamic import with `'use client'` boundary; WASM init skipped on server |
| Session state persistence (IndexedDB) | Phase-2 task — `InMemorySignalProtocolStore` stub ships now; IndexedDB store is next |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Application layer (sendEncryptedMessage,   │
│  sendEncryptedFile, buildEnvelopes)         │
└────────────────┬────────────────────────────┘
                 │ uses
                 ▼
┌─────────────────────────────────────────────┐
│  SessionCrypto interface (session.ts)        │
│  encryptToDevice() / buildEnvelopes()        │
└────────┬────────────────────┬───────────────┘
         │ Phase-1            │ Phase-2
         ▼                    ▼
┌─────────────────┐  ┌────────────────────────┐
│ Phase1Session-  │  │ LibsignalSessionCrypto │
│ Crypto          │  │ (signalClient.ts stub) │
│ WebCrypto ECDH  │  │ @signalapp/libsignal-  │
│ + AES-256-GCM   │  │ client (WASM)          │
└─────────────────┘  └────────────────────────┘
```

### Phase-1 (current — default)

- `Phase1SessionCrypto` in `session.ts`
- Sealed-box: ECDH ephemeral key + HKDF + AES-256-GCM
- No forward secrecy (each message independent)
- No ratchet — fresh ephemeral key per message

### Phase-2 (Signal — next)

- `LibsignalSessionCrypto` in `session.ts`
- Full Signal Double-Ratchet: X3DH key agreement + ratcheting
- Forward secrecy + break-in recovery
- Requires prekey bundle exchange (signedPreKey + oneTimePreKey)

---

## Activation checklist

```bash
# 1. Install the library
cd apps/web
npm install @signalapp/libsignal-client

# 2. Implement signalClient.ts (fill in the stub functions)
#    Follow @signalapp/libsignal-client README for SessionCipher usage.

# 3. Activate in session.ts:
#    Change: export const defaultSession = new Phase1SessionCrypto()
#    To:     export const defaultSession = new LibsignalSessionCrypto()

# 4. Implement IndexedDB-backed SignalProtocolStore
#    (replaces in-memory store in signalClient.ts)
```

---

## Bundle-size impact

| Asset | Size (gzip est.) | Notes |
|---|---|---|
| `@signalapp/libsignal-client` WASM | ~380 KB | Loaded lazily on first message send |
| Phase-1 crypto.ts | ~4 KB | Always loaded |
| session.ts + signalClient.ts | ~3 KB | Always loaded (stubs only until Phase-2) |

The WASM chunk is isolated behind a dynamic `import()` call in
`LibsignalSessionCrypto.encryptToDevice`. It will not appear in the initial
page load waterfall.

---

## References

- [libsignal GitHub](https://github.com/signalapp/libsignal)
- [npm: @signalapp/libsignal-client](https://www.npmjs.com/package/@signalapp/libsignal-client)
- [Cure53 2016 audit (PDF)](https://cure53.de/pentest-report_signal-android.pdf)
- [Cure53 2019 Desktop audit (PDF)](https://github.com/signalapp/Signal-Desktop/blob/main/docs/Cure53%20Security%20Audit.pdf)
- [Signal Protocol specification](https://signal.org/docs/)
