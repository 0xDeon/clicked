# MLS integration

The web client integrates the maintained [`@openmls/wasm`](https://www.npmjs.com/package/@openmls/wasm) binding through `src/lib/mls.ts`. The binding is loaded only in a browser context, so the MLS implementation and its private state are never initialized on the server.

## Protocol and ciphersuite

- Protocol: Messaging Layer Security (MLS), specified by [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420).
- Selected ciphersuite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.
- The ciphersuite provides 128-bit symmetric security, X25519 HPKE key agreement, AES-128-GCM authenticated encryption, SHA-256 hashing, and Ed25519 signatures.
- Group state transitions, epochs, ratchets, credentials, and private keys are owned by the browser-side OpenMLS WASM client.

The application uses OpenMLS for the MLS wire protocol and does not implement MLS cryptography itself. RFC 9420 conformance is therefore dependent on the selected OpenMLS release and its upstream test suite. Application-level interoperability testing against another RFC 9420 implementation remains required before describing the product as fully interoperable.

## Audit status

No independent security audit of the exact `@openmls/wasm` artifact, its WebAssembly build, or this adapter has been completed by DripTide. Upstream maintenance and release history are not a substitute for an application-specific audit. The dependency version is explicitly declared in `apps/web/package.json` so upgrades can be reviewed and audited.

## State and backend boundary

`MlsClient.exportState()` returns opaque state for local browser persistence only. It must not be included in API requests, WebSocket messages, logs, analytics, or crash reports. The transport boundary may carry only:

- public credentials and key packages needed for onboarding;
- MLS Welcome, Proposal, and Commit messages;
- MLS ciphertext and authenticated data.

The backend is an untrusted relay and never receives group state, epoch secrets, ratchet secrets, signing private keys, plaintext, or exported client state. Decryption occurs only after ciphertext reaches a client holding the corresponding local group state.
