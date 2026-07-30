# Phase-1 → Signal migration

Clicked shipped on the **Phase-1 sealed box**: ECDH ephemeral key + HKDF +
AES-256-GCM, one independent box per recipient device per message. It has no
forward secrecy and no ratchet. The **Signal Double Ratchet** replaces it (see
[../../../docs/signal-integration.md](../../../docs/signal-integration.md) for
the library decision).

Clients update at their own pace, so for as long as the slowest device takes,
a conversation contains devices on both sides of the line. This document defines
how that transition happens without losing any history.

## The three rules

1. **History is never re-encrypted.** Envelopes written before the cutover keep
   `protocol = 'sealed_box'` and stay decryptable by the Phase-1 path forever.
   The cutover changes what is written next, never what was written before.
2. **A conversation cuts over only when every active device on every side
   advertises Signal support.** A single un-upgraded device holds the whole
   conversation on sealed box, because the sender has to produce something that
   device can actually open.
3. **After cutover, sealed box is refused.** Without this, a patched or
   compromised client could keep a conversation on the weaker construction
   indefinitely and nobody would notice.

## Data model

Two additions (migration `drizzle/0001_signal_migration.sql`):

### `devices.supports_signal` — the capability flag

`boolean NOT NULL DEFAULT false`. Every already-registered device starts at
`false`, so nothing cuts over until each device explicitly says it can.

**The flag is monotonic: a device may turn it on but not off.** Accepting a
withdrawal would hand any client a lever to pull the whole conversation back
onto the Phase-1 construction, and the other side has no way to tell that from a
genuine rollback. A device that really has lost its Signal state re-registers
under a new identity key, which produces a new row starting at `false`.

### `message_envelopes.protocol` — what actually encrypted this envelope

`e2ee_protocol NOT NULL DEFAULT 'sealed_box'`, an enum of `sealed_box | signal`.

Adding the column with that default backfills every existing row in the same
statement. **This is the no-history-loss guarantee:** every envelope ever
written is labelled with the construction that produced it, so a client always
knows which decryption path to use rather than inferring it from the ciphertext
or from when the message was sent.

The column is per envelope, not per conversation, because a conversation
legitimately contains both during the transition.

## Advertising capability

A client that has shipped Signal support tells the server once, after upgrading:

```http
PATCH /devices/:id/capabilities
{ "supportsSignal": true }
```

```json
{ "id": "uuid", "supportsSignal": true, "changed": true }
```

- Owner-only; revoked devices are refused.
- Idempotent — re-sending `true` returns `changed: false`.
- `false` after `true` returns `409` (see monotonicity above).

Capability can also be declared at registration, on `POST /devices` and inside
the `device` object of `POST /auth/verify`, via the same `supportsSignal` field.
Both paths only ever raise the flag; neither clears it.

`GET /devices` reports `supportsSignal` for each of the caller's devices.

## Negotiation

```http
GET /conversations/:id/e2ee-protocol
```

```json
{
  "conversationId": "uuid",
  "protocol": "sealed_box",
  "totalActiveDevices": 3,
  "signalCapableDevices": 2,
  "blockingDevices": [
    { "deviceId": "uuid", "userId": "uuid", "deviceName": "old phone", "platform": "ios" }
  ]
}
```

`protocol` is the answer to "what must new messages here use". It is `signal`
only when `blockingDevices` is empty _and_ there is at least one active device —
an empty device set stays on `sealed_box`, because reporting `signal` there
would flip the conversation to a mode no device can read the moment one joins.

`blockingDevices` exists so the UI can say _which_ device is holding things up
rather than showing an unexplained "still on legacy encryption" badge.

`GET /conversations/:id/devices` — the call clients already make immediately
before encrypting — now returns `protocol` alongside the device list, and each
device carries its `supportsSignal` flag. Reading capability and protocol from
two separate requests would leave a window where the client encrypts for a
device set that has since changed.

## Sending

Each envelope declares its protocol:

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "contentType": "text",
  "ciphertext": "base64",
  "envelopes": [{ "recipientDeviceId": "uuid", "ciphertext": "base64", "protocol": "signal" }]
}
```

`protocol` is optional and defaults to `sealed_box`, so clients written before
this change keep working untouched.

The server rejects two things, and they are different problems:

| Status | When                                                          | Meaning                                                        |
| ------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `400`  | A `signal` envelope addressed to a device that cannot read it | The sender got ahead of the recipient.                         |
| `409`  | A `sealed_box` envelope after the conversation has cut over   | Downgrade. The sender should re-encrypt with Signal and retry. |

Both responses carry `negotiatedProtocol` and `offendingDeviceIds`, so the
client re-fetches the device set and rebuilds rather than retrying blind:

```json
{
  "error": "This conversation has cut over to Signal; sealed-box envelopes are no longer accepted",
  "negotiatedProtocol": "signal",
  "offendingDeviceIds": ["uuid"]
}
```

The WebSocket `send_message` path enforces the identical rule and emits an
`error` event with `event: "protocol_mismatch"` carrying the same fields.

## Reading

Every read path reports the protocol per envelope so the client picks the right
decryption routine:

- `GET /sync` — each envelope carries `protocol`.
- `message_envelope` socket events — carry `protocol`.
- `GET /conversations/:id/messages` — envelope rows carry `protocol`.

A client catching up across the cutover therefore receives a mix of
`sealed_box` and `signal` envelopes in one page and decrypts each with the
matching path. Nothing has to be migrated, re-encrypted, or re-downloaded.

## Cutover timeline

```text
        all devices Phase-1          mixed                all devices Signal
        ────────────────────  ──────────────────────  ────────────────────────
protocol      sealed_box            sealed_box                 signal

new msgs      sealed box            sealed box                 Signal
              only                  only (the lagging          only (sealed box
                                    device would not           is refused)
                                    be able to read
                                    a Signal envelope)

old msgs      sealed box            sealed box                 sealed box
              decrypt on            decrypt on                 decrypt on
              Phase-1 path          Phase-1 path               Phase-1 path
                                    ▲
                                    │
                          one device upgrading does not
                          change anything on its own
```

The conversation flips the moment the last device advertises support. Nothing
is rewritten at that instant — only the next message differs.

## Rollout checklist

1. Apply `drizzle/0001_signal_migration.sql`. Existing envelopes are labelled
   `sealed_box`; existing devices are `supports_signal = false`. Behaviour is
   unchanged at this point.
2. Ship a client that can _decrypt_ both paths, keyed off the envelope
   `protocol` field, but still encrypts with sealed box. This is safe to deploy
   widely because it changes nothing about what is written.
3. Ship the client that can _encrypt_ with Signal, and have it
   `PATCH /devices/:id/capabilities` on first run.
4. Conversations cut over on their own as their last device upgrades. Use
   `blockingDevices` to prompt the stragglers.
5. Phase-1 decryption stays in the client indefinitely — history predating the
   cutover only decrypts that way.

Step 2 must fully precede step 3. A device that can encrypt with Signal but is
talking to one that cannot decrypt it produces envelopes nobody can open — which
is exactly the `400` above, but it is better not to rely on the server catching
it.

## Implementation references

- schema: `apps/backend/src/db/schema.ts` (`devices.supportsSignal`, `messageEnvelopes.protocol`)
- migration: `apps/backend/drizzle/0001_signal_migration.sql`
- negotiation + enforcement: `apps/backend/src/services/e2eeProtocol.ts`
- capability endpoint: `apps/backend/src/routes/devices.ts`
- negotiation endpoint: `apps/backend/src/routes/conversations.ts`
- send paths: `apps/backend/src/routes/messages.ts`, `apps/backend/src/socket/messaging.ts`
- read paths: `apps/backend/src/routes/sync.ts`, `apps/backend/src/services/deliveryPipeline.ts`
- client crypto layer: `apps/web/src/lib/session.ts`, `apps/web/src/lib/signalClient.ts`
- tests: `apps/backend/src/__tests__/e2eeProtocol.test.ts`, `signalMigration.routes.test.ts`
