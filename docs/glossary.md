# Glossary

This glossary documents the domain vocabulary used across the codebase. The
project mixes terms from three sources:

- **Messaging / E2EE** — standard cryptographic-messaging protocol terms (Signal
  double ratchet, MLS, NaCl sealed boxes).
- **Stellar / Soroban** — standard blockchain-platform terms from the Stellar
  network and its Soroban smart-contract layer.
- **Project-specific coinages** — terms invented by this codebase that won't be
  found in any external spec.

Each entry is tagged **[standard]** or **[project-specific]** and, where useful,
points at the module that implements it.

---

## 1. Messaging / E2EE terms **[standard, unless noted]**

- **Envelope** — A single per-device encrypted payload: one message, sealed
  separately for one recipient device. Persisted as one row per
  `(message, recipient device)` pair in the `message_envelopes` table
  (`apps/backend/src/db/schema.ts`), built client-side in `buildEnvelopes`
  (`apps/web/src/lib/crypto.ts`) and consumed in
  `apps/web/src/lib/crypto/processEnvelope.ts`. General term from
  secure-messaging protocol design (Signal, MLS, etc.), not Stellar-specific.

- **Prekey** — A pre-published public key (signed prekey / one-time prekey)
  that lets a sender start an encrypted session with a device that is
  currently offline, per the Signal/X3DH key-agreement pattern. Validated and
  stored in `apps/backend/src/lib/keys.ts`; low-prekey alerting lives in
  `apps/backend/src/services/prekeyLowSignal.ts`.

- **Ratchet (Double Ratchet)** — The Signal Double Ratchet algorithm: a
  per-session symmetric-key ratchet combined with a DH ratchet, giving
  forward secrecy and post-compromise security for one-to-one sessions.
  Implemented in `apps/web/src/lib/crypto/doubleRatchet.ts` (`ratchetEncrypt`
  / `ratchetDecrypt`), with the persisted session layer in
  `apps/web/src/lib/crypto/ratchetSession.ts` / `signalSession.ts`.

- **Safety number** — A human-verifiable fingerprint computed from both
  parties' identity keys, used to detect key/identity changes (aka "safety
  number changed" in Signal). Surfaced in
  `apps/web/src/app/app/conversations/[id]/page.tsx`
  (`loadSafetyNumber`, `hasChangedSafetyNumber`) and the `safety_number_changed`
  socket event.

- **Epoch (MLS epoch)** — The MLS group-state version number: every commit
  (member add/remove, key rotation) advances the group to a new epoch, and a
  device can only decrypt messages encrypted in epochs it was a member for.
  Tracked as `mlsGroups.currentEpoch`, `mlsCommits.epoch`,
  `mlsWelcomes.epoch`, and the join/leave interval columns
  `mlsGroupMembers.joinedAtEpoch` / `removedAtEpoch`
  (`apps/backend/src/db/schema.ts`). See the disambiguation section below —
  this is distinct from `groupControlEvents.sequence`.

- **Sealed box** — A NaCl/libsodium "anonymous" sealed-box construction
  (ephemeral ECDH + HKDF + AEAD) used for the project's original, pre-MLS
  encryption scheme. Implemented as `sealedBoxEncrypt` in
  `apps/web/src/lib/crypto.ts` and recorded as the `sealed_box` value of the
  `e2ee_protocol` enum in `apps/backend/src/db/schema.ts`
  (`messageEnvelopes.protocol`), alongside `signal` and `mls`. See
  `apps/backend/src/services/e2eeProtocol.ts` for how protocol selection
  across devices is negotiated.

- **Fan-out** — The server-side act of taking one outbound message and
  delivering/copying it out to every recipient device (one envelope per
  device, socket push, offline queueing). Implemented in
  `apps/backend/src/services/fanout.ts`,
  `apps/backend/src/lib/messageFanout.ts`, and
  `apps/backend/src/services/deviceDelivery.ts`. General distributed-messaging
  term, not specific to any single protocol.

---

## 2. Stellar / Soroban terms **[standard]**

- **Ledger** — Stellar's unit of consensus: the blockchain's equivalent of a
  block, each with a sequence number. The backend's on-chain event listener
  tracks the `ledger` a transaction/event landed in (
  `apps/backend/src/services/stellarListener.ts`, field `ledger: number`) to
  detect chain reorgs/gaps and resume from the right point.

- **XDR** — Stellar/Soroban's binary wire encoding ("External Data
  Representation") for transactions, contract values (`ScVal`), and results.
  Used throughout `apps/web/src/lib/soroban.ts` (`xdr.ScVal.scvSymbol(...)`,
  `signedTxXdr`) when building and signing Soroban invocations client-side.

- **SAC (Stellar Asset Contract)** — Soroban's built-in contract wrapper that
  exposes a classic Stellar asset (an `(issuer, code)` pair, e.g.
  `USDC:GA5Z...`) as a SEP-41-compatible token contract with a deterministic
  address. The project's `token_transfer` and `group_treasury` contracts are
  written against the generic SEP-41 interface so they work with any SAC or
  custom SEP-41 token (`contracts/contracts/token_transfer/src/token_interface.rs`,
  documented in `contracts/docs/concepts-token-transfer-flow.md`).

- **Passphrase (network passphrase)** — The string that identifies which
  Stellar network (e.g. testnet vs. public) a transaction is signed for;
  included in transaction signing to prevent cross-network replay. Read from
  `NEXT_PUBLIC_NETWORK_PASSPHRASE` in `apps/web/src/lib/soroban.ts`.

- **Freighter** — The browser-extension Stellar wallet used for user
  authentication and transaction signing in this app ("Sign in with your
  Freighter wallet" — `apps/web/src/components/landing/HowItWorks.tsx`).
  Wrapped in `apps/web/src/lib/freighter.ts`
  (`requestAccess`/`signMessage` from `@stellar/freighter-api`) and consumed
  by `WalletContext.tsx` / `AuthContext.tsx`.

---

## 3. Project-specific coinages **[project-specific — not standard terms]**

- **Device set mismatch** — The error code (`device_set_mismatch`, issue
  #133) returned when a client encrypts a message for a stale set of
  recipient devices — i.e. it omitted an envelope for a device the server
  knows about (a sibling device that came online, or wasn't yet known to the
  sender). The server responds with the missing device IDs so the client can
  re-encrypt and retry exactly once. Implemented client-side in
  `apps/web/src/lib/crypto.ts` (search `device_set_mismatch`) and documented
  in `apps/web/docs/concepts-message-pipeline.md`.

- **Sibling device** — Any other device belonging to the *same* user as the
  sender/recipient (as opposed to a different user's device). Because this
  is a multi-device E2EE design, a user's own sibling devices are each
  independent encryption targets requiring their own session/envelope, exactly
  like another person's device. See `apps/web/src/lib/signalClient.ts` (its
  header comment coins the term) and `fetchSiblingDeviceIds` referenced from
  `apps/web/docs/concepts-message-pipeline.md`.

- **Resume cursor** — A client-persisted "last seen event ID" used to resume
  the realtime socket stream after a reconnect without re-fetching or missing
  events, analogous to a Kafka offset/cursor but specific to this project's
  socket protocol. Read/written via `getResumeCursor` / `setResumeCursor` in
  `apps/web/src/lib/socket.ts` and `apps/web/src/hooks/useSocket.ts`, sent as
  `lastEventId` on the `resume` socket event; server-side counterpart in
  `apps/backend/src/services/resumeStream.ts`.

- **Group control event** — A row in the `group_control_events` table
  representing one membership-affecting action in a conversation
  (`member_added`, `member_removed`, `member_left`, `commit`), each carrying
  the group's post-event `epoch` and a gap-free per-conversation `sequence`
  number. This is the project's own audit/catch-up log built on top of MLS
  group state — the MLS commit/welcome material itself is carried opaquely
  in the event's `payload` column. Defined in
  `apps/backend/src/db/schema.ts` and produced by
  `apps/backend/src/services/groupControl.ts`.

---

## 4. Disambiguation: confusable pairs

### `ciphertext` (message body) vs. envelope `ciphertext` (per-device payload)

Both are literal column names but on different tables and mean different
things:

- **`messages.ciphertext`** (`apps/backend/src/db/schema.ts`) is a single
  column on the message row itself. It holds the opaque, E2EE-encrypted
  message body for protocols that carry one ciphertext per message (or is
  `NULL` when the message instead has per-device rows in
  `message_envelopes`, or when it's a `system` message, which carries
  `systemPayload` instead and must have `ciphertext IS NULL`, enforced by a
  CHECK constraint).
- **`messageEnvelopes.ciphertext`** is a separate table, one row *per
  recipient device*, holding that device's independently sealed copy of the
  same plaintext (see "Envelope" above). A single logical message can have
  zero-to-many envelope rows, each with its own ciphertext, versus at most one
  `messages.ciphertext`.

In short: `messages.ciphertext` is "the (optional) single encrypted blob on
the message," `message_envelopes.ciphertext` is "the per-device encrypted
copy," and the two are mutually complementary depending on which E2EE
protocol produced the message (see `protocol` / `mlsEpoch` columns and
`apps/backend/src/lib/ciphertextInvariant.ts`, which enforces the invariant
between them).

### `deviceId` vs `senderDeviceId`

- **`deviceId`** is the generic column name used wherever a table references
  "some device" without an implied role — e.g.
  `pushSubscriptions.deviceId`, `mlsGroupMembers.deviceId`,
  `mlsCommits`/`mlsWelcomes`/`mlsKeyPackages`/`deviceKeyHistory` — all `deviceId`,
  all foreign keys into the single canonical `devices` table.
- **`senderDeviceId`** is specifically the column on `messages`
  (`apps/backend/src/db/schema.ts`) identifying *which one device, of
  potentially several belonging to the sending user*, actually sent/encrypted
  this particular message — needed because of multi-device support (a user's
  sibling devices each have independent identity keys and sessions, so the
  system must know exactly which device's key produced the message).

So `senderDeviceId` is a role-qualified `deviceId` used only where the
sending device specifically (as opposed to some other role, e.g. recipient)
needs to be recorded; `messageEnvelopes.recipientDeviceId` is the
symmetric recipient-side equivalent.

### `epoch` (MLS epoch) vs `sequence` (group control log sequence number)

These live on the same `group_control_events` row but track different axes:

- **`epoch`** is the *MLS group cryptographic state version* — it only
  changes when a commit actually changes the group's secrets (member
  add/remove, key rotation). It determines what a device can decrypt (see
  "Epoch" above).
- **`sequence`** is a plain, strictly-increasing, gap-free *log position*
  within one conversation's `group_control_events` (enforced by the unique
  index `group_control_conversation_sequence_idx` on
  `(conversationId, sequence)`), used purely for ordered catch-up/replay of
  the control log — it has no cryptographic meaning and increments on every
  control event, whether or not that event bumps the epoch.

In other words: `sequence` numbers *events*, `epoch` numbers *group crypto
states* — an event's `sequence` always advances by exactly one per event,
while its `epoch` only advances when that event actually rotates group
secrets (comment in schema.ts: "join and leave can never be assigned the
same sequence number," clarifying that `sequence` is unconditionally unique
per event, unlike `epoch`).
