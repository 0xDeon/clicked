# Phase-1 → Signal migration

Clicked shipped on the **Phase-1 sealed box**: ECDH ephemeral key + HKDF +
AES-256-GCM, one independent box per recipient device per message. It has no
forward secrecy and no ratchet. The **Signal Double Ratchet** replaces it (see
[../../../docs/signal-integration.md](../../../docs/signal-integration.md) for
the library decision).

Clients update at their own pace, so a conversation contains devices on both
sides of that line for as long as the slowest one takes. This document defines
how that transition happens without losing any history.

## What this builds on

Capability advertisement already exists: `devices.capabilities` is a JSON
document listing the `protocols` a device can decrypt, and `selectProtocol`
(`src/lib/capabilities.ts`) picks the strongest one two devices share, falling
back to the universal `sealed_box` baseline.

This migration adds the two things negotiation alone does not provide:

1. **Enforcement on the way in.** A sender can _claim_ any protocol on an
   envelope. Two claims have to be rejected.
2. **A record of what was actually used.** Capabilities change over time, so
   they cannot be used to interpret an envelope written months ago.

## The three rules

1. **History is never re-encrypted.** Every envelope records the construction
   that produced it, so anything written before a pair cut over keeps
   decrypting on the Phase-1 path forever. The cutover changes what is written
   next, never what was written before.
2. **A device pair uses the strongest protocol both sides advertise.** Not the
   weakest in the conversation — see below.
3. **A weaker protocol than both sides support is refused.** Without this a
   patched or compromised client could quietly keep a peer on the sealed box
   forever and nobody would notice.

### Negotiation is per device pair, not per conversation

The envelope model already encrypts once per recipient device. There is
therefore no reason to hold a Signal-capable device back because some other
member of the conversation is still on an old client: that pair gets Signal
today, and the laggard keeps sealed box until it upgrades.

A conversation-wide "everyone must be ready" gate would be simpler to describe
but strictly worse — it would delay forward secrecy for every pair in a group
until the last straggler updated, which in a large group may be never.

## Data model

Migration `drizzle/0004_envelope_protocol.sql` adds one column:

`message_envelopes.protocol` — `e2ee_protocol NOT NULL DEFAULT 'sealed_box'`,
an enum of `sealed_box | signal | mls` mirroring `KNOWN_PROTOCOLS`.

Adding it with that default backfills every existing row in the same statement.
**This is the no-history-loss guarantee:** every envelope ever written is
labelled with the construction that produced it, so a client picks the
decryption path from the data rather than inferring it from the ciphertext or
from when the message was sent.

The column is per envelope, not per conversation or per device, because a
conversation legitimately contains both during the transition — and because
`devices.capabilities` describes what a device can do _now_, which says nothing
about what encrypted a message last month.

No column is added to `devices`: capability advertisement already lives in
`devices.capabilities`.

## Advertising Signal support

A client that has shipped Signal support re-verifies with a widened protocol
list. `POST /auth/verify` treats a newer `capabilities` document as the upgrade
path and updates the stored one — no re-registration, no separate endpoint:

```json
{
  "walletAddress": "G...",
  "signature": "...",
  "nonce": "...",
  "identityPublicKey": "base64",
  "device": {
    "deviceName": "laptop",
    "platform": "web",
    "identityPublicKey": "base64",
    "capabilities": { "protocols": ["sealed_box", "signal"] }
  }
}
```

A device that has never advertised capabilities — including every row written
before the column existed — is treated as `sealed_box`-only.

## Reading the negotiated protocol

`GET /conversations/:id/devices` already returns, per device, its
`capabilities` and the `negotiatedProtocol` the calling device should use with
it. That is the same value the send path enforces, so a client that echoes it
back on each envelope cannot trip the checks below.

## Sending

Each envelope declares its protocol. It is optional and defaults to
`sealed_box`, so clients written before this change keep working untouched:

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "contentType": "text",
  "ciphertext": "base64",
  "envelopes": [
    { "recipientDeviceId": "uuid", "ciphertext": "base64", "protocol": "signal" },
    { "recipientDeviceId": "uuid", "ciphertext": "base64", "protocol": "sealed_box" }
  ]
}
```

Note the mixed batch: that is normal and correct during the migration.

The server rejects two things, and they are different problems:

| Status | Reason                     | Meaning                                                                                                                                                      |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400`  | `unsupported_by_recipient` | The envelope names a protocol the recipient does not advertise. It would be undecryptable on arrival, which the recipient cannot distinguish from tampering. |
| `409`  | `downgrade`                | Both devices can do better than what the envelope claims. Re-encrypt and retry.                                                                              |

Both responses list every offending envelope so the client can re-fetch the
device set and rebuild rather than retrying blind:

```json
{
  "error": "Envelope protocol is weaker than both devices support",
  "violations": [
    {
      "recipientDeviceId": "uuid",
      "declared": "sealed_box",
      "expected": "signal",
      "reason": "downgrade"
    }
  ]
}
```

When a batch contains both kinds, the undecryptable envelope decides the status
code — it is the more specific failure.

The WebSocket `send_message` path enforces the identical rule and emits an
`error` event with `event: "protocol_mismatch"` carrying the same `violations`.

MLS group messages carry a single group ciphertext and no per-device envelopes
(#372), so there is nothing to negotiate and the check does not run.

## Reading

Every read path reports the protocol per envelope so the client picks the right
decryption routine:

- `GET /sync` — each envelope carries `protocol`.
- `message_envelope` socket events — carry `protocol`.
- `GET /conversations/:id/messages` — envelope rows carry `protocol`.

A client catching up across the cutover therefore receives a mix of
`sealed_box` and `signal` envelopes in one page and decrypts each with the
matching path. Nothing is migrated, re-encrypted, or re-downloaded.

## Cutover timeline for one device pair

```text
        both Phase-1            one upgraded              both upgraded
        ─────────────────  ──────────────────────  ────────────────────────
negotiated   sealed_box          sealed_box                 signal

new msgs     sealed box          sealed box                 Signal only
                                 (the other side            (sealed box is
                                  could not read            refused)
                                  a Signal envelope)

old msgs     sealed box          sealed box                 sealed box
             decrypt on          decrypt on                 decrypt on
             Phase-1 path        Phase-1 path               Phase-1 path
```

The pair flips the moment the second device advertises support. Nothing is
rewritten at that instant — only the next message differs.

## Rollout order

1. Apply `drizzle/0004_envelope_protocol.sql`. Existing envelopes are labelled
   `sealed_box`. Behaviour is unchanged at this point.
2. Ship a client that can **decrypt** both paths, keyed off the envelope
   `protocol` field, but still encrypts with sealed box. Safe to deploy widely
   because it changes nothing about what is written.
3. Ship the client that can **encrypt** with Signal, and have it re-verify with
   `protocols: ["sealed_box", "signal"]` on first run.
4. Pairs cut over on their own as both sides upgrade. `GET /conversations/:id/devices`
   shows which devices are still on the baseline.
5. Phase-1 decryption stays in the client indefinitely — history predating the
   cutover only decrypts that way.

Step 2 must fully precede step 3. A device that can encrypt with Signal while
talking to one that cannot decrypt it produces envelopes nobody can open —
which is exactly the `400` above, but it is better not to rely on the server
catching it.

## Implementation references

- schema: `apps/backend/src/db/schema.ts` (`messageEnvelopes.protocol`, `e2eeProtocolEnum`)
- migration: `apps/backend/drizzle/0004_envelope_protocol.sql`
- capability model + negotiation: `apps/backend/src/lib/capabilities.ts`
- enforcement: `apps/backend/src/services/e2eeProtocol.ts`
- envelope persistence: `apps/backend/src/lib/messageFanout.ts`
- send paths: `apps/backend/src/routes/messages.ts`, `apps/backend/src/socket/messaging.ts`
- read paths: `apps/backend/src/routes/sync.ts`, `apps/backend/src/services/deliveryPipeline.ts`
- client crypto layer: `apps/web/src/lib/session.ts`, `apps/web/src/lib/signalClient.ts`
- tests: `apps/backend/src/__tests__/e2eeProtocol.test.ts`, `signalMigration.routes.test.ts`
