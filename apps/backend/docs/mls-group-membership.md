# MLS group membership and new-device join

Group conversations use MLS (RFC 9420). This document describes how a device
joins a group it was not originally part of — most often a device a user has
just linked to their account — and what that device can and cannot read
afterwards.

The short version, and the property users need to understand:

> **A newly-linked device cannot read group messages sent before it joined.**
> It reads everything from its join epoch onwards. Earlier messages appear in
> the timeline as "unavailable on this device", not as errors.

## Why history does not transfer

MLS derives the key for each message from the group's secrets at a particular
**epoch**. Those secrets are derived from the ratchet tree, and a device's
contribution to the tree — its leaf — only exists from the commit that added it.

A device added by the commit that produces epoch 7 therefore holds the epoch-7
secrets and every later epoch's, and has no way to derive the epoch-6 secrets or
anything before them. There is no key on the server to send it, because the
server never had one: it stores ciphertext and public group state only.

This is the same property that makes removal meaningful. If a joining device
could reconstruct old epochs, then so could a device that was removed and
re-added, and post-removal forward secrecy would not hold.

Backfilling history would require an existing device to re-encrypt and re-send
past plaintext to the new device. That is a separate deferred feature (a
history/recovery service), and until it exists the "no history for new device"
property above is the behaviour.

## What the server stores

The server is a transport and an ordering service. It holds the public ledger
the group needs to agree on and no group secrets.

| Table               | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `mls_groups`        | One row per group conversation: group id, cipher suite, current epoch.  |
| `mls_group_members` | A device's leaf, recorded as the epoch interval it can decrypt.         |
| `mls_commits`       | Append-only log of the commit that produced each epoch.                 |
| `mls_welcomes`      | Welcome messages held for devices that are offline when they are added. |

`messages.mls_epoch` records which epoch encrypted a group message. It is null
for DMs, system events, and any message sent before the conversation adopted
MLS.

### Membership is an epoch interval, not a flag

`mls_group_members` stores `joined_at_epoch` and a nullable `removed_at_epoch`.
A device can read epoch `e` when:

```text
joined_at_epoch <= e < (removed_at_epoch ?? infinity)
```

A device that is removed and later re-added gets a second row with a later
`joined_at_epoch`. The intervals are deliberately not merged: the device
genuinely cannot read the epochs it was absent for.

## Join flow for a newly-linked device

```text
New device                Backend                    Existing member device
  |                          |                                 |
  |-- POST /devices -------->|                                 |
  |-- publish MLS key -------|                                 |
  |   packages               |-- device_added system event --->|
  |                          |                                 |
  |                          |<-- GET /conversations/:id/mls/ -|
  |                          |    pending-devices              |
  |                          |--- [{ deviceId, ... }] -------->|
  |                          |                                 |
  |                          |         claims a key package, builds
  |                          |         Add proposal + Commit + Welcome
  |                          |                                 |
  |                          |<-- POST /conversations/:id/mls/-|
  |                          |    commits { epoch, commit,     |
  |                          |      addedDevices: [{ welcome }]}|
  |                          |                                 |
  |<- mls_welcome_available -|--- mls_commit ----------------->|
  |                          |                                 |
  |-- GET /conversations/:id |                                 |
  |   /mls/welcome --------->|                                 |
  |<- { epoch, welcome } ----|                                 |
  |                          |                                 |
  |-- GET /conversations/:id |                                 |
  |   /mls/commits --------->|                                 |
  |<- commits since join ----|                                 |
  |                          |                                 |
  |   now decrypts every message from its join epoch onwards    |
```

1. The device registers and publishes MLS key packages (see
   [mls-key-packages.md](./mls-key-packages.md)).
2. It appears in `GET /conversations/:id/mls/pending-devices` for every group
   its user belongs to.
3. An existing member claims one of its key packages, builds an Add proposal and
   a Commit, and publishes both — together with the Welcome — via
   `POST /conversations/:id/mls/commits`.
4. The new device claims the Welcome and replays commits from its join epoch.

Steps 3 and 4 are decoupled by design: the Welcome is held until the device
comes online, so a device can be added to groups while it is offline.

## Endpoints

All require `Authorization: Bearer <jwt>` and conversation membership. Routes
that need group state return `404` when the conversation has no MLS group.

### `POST /conversations/:id/mls/group`

Records the public group identifiers after the founding client creates the group
locally, and seats the founder's device at epoch 0.

```json
{ "groupId": "base64", "cipherSuite": 1 }
```

`409` if the conversation already has a group; `400` for a DM.

### `GET /conversations/:id/mls/group`

```json
{
  "conversationId": "uuid",
  "groupId": "base64",
  "cipherSuite": 1,
  "currentEpoch": 7,
  "membership": { "joinedAtEpoch": 7, "removedAtEpoch": null, "active": true },
  "pendingWelcome": null,
  "historyAvailableFromEpoch": 7
}
```

`historyAvailableFromEpoch` is what a client should drive its UI from. Anything
before it is permanently unreadable on this device, so the client can render a
one-time explanation at the top of the timeline rather than a row of broken
messages. It is `null` until the device has a leaf.

### `GET /conversations/:id/mls/pending-devices`

Active devices of conversation members that hold no leaf yet — the set a
committer has to Add.

```json
{
  "currentEpoch": 7,
  "devices": [{ "deviceId": "uuid", "userId": "uuid", "identityPublicKey": "base64" }]
}
```

### `POST /conversations/:id/mls/commits`

```json
{
  "epoch": 8,
  "commit": "base64",
  "addedDevices": [{ "deviceId": "uuid", "welcome": "base64" }],
  "removedDeviceIds": ["uuid"]
}
```

- `epoch` must be exactly `currentEpoch + 1`. Two members committing at the same
  moment both claim the same epoch; the group row is locked for the duration of
  the write, so one applies and the other gets:

  ```json
  {
    "error": "Commit epoch conflict — another commit was applied first",
    "currentEpoch": 8,
    "expectedEpoch": 9
  }
  ```

  The loser re-derives its commit against the new epoch and retries.

- Only a device that currently holds a leaf may commit (`403` otherwise).
- Added devices must be active devices of conversation members (`400`
  otherwise), so a member cannot smuggle an arbitrary device into the group.
- A device cannot be added and removed by the same commit.

On success the server emits `mls_commit` to the conversation room and
`mls_welcome_available` to each added device's room.

### `GET /conversations/:id/mls/commits`

Commit replay for a device catching up.

- `?sinceEpoch=` defaults to the device's join epoch and is clamped to it —
  earlier commits belong to a tree the device had no leaf in and cannot be
  applied.
- `?limit=` up to 200.

```json
{ "conversationId": "uuid", "sinceEpoch": 7, "currentEpoch": 9, "commits": [...], "hasMore": false }
```

### `GET /conversations/:id/mls/welcome`

Claims the device's pending Welcome and marks it consumed.

```json
{
  "conversationId": "uuid",
  "groupId": "base64",
  "cipherSuite": 1,
  "epoch": 7,
  "welcome": "base64",
  "currentEpoch": 9
}
```

`404` when nothing is pending. If several Welcomes queued up while the device
was offline, the newest is returned — it is the only one still usable.

## How unavailable messages are surfaced

Both message read paths — `GET /conversations/:id/messages` and the socket
`message_history` event — apply the same rule. A message whose `mlsEpoch` falls
outside the requesting device's window comes back with its ciphertext blanked
and a reason attached:

```json
{
  "id": "uuid",
  "senderId": "uuid",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "mlsEpoch": 4,
  "ciphertext": null,
  "unavailable": true,
  "unavailableReason": "mls_no_key_before_join"
}
```

Reason codes:

| Code                       | Meaning                                       |
| -------------------------- | --------------------------------------------- |
| `mls_no_key_before_join`   | Sent before this device joined the group.     |
| `mls_no_key_after_removal` | Sent after this device was removed.           |
| `mls_not_a_group_member`   | This device holds no leaf in the group (yet). |

Three deliberate choices here:

- **Not an error.** The server knows in advance that the device cannot decrypt
  these messages. Returning ciphertext and letting decryption fail would be
  indistinguishable, on the client, from tampering — and training users to
  dismiss decryption failures destroys a signal that is supposed to mean
  something.
- **Not omitted.** Sender, timestamp and epoch are preserved so the client can
  render a placeholder in the correct position. A gap in the timeline is more
  alarming than a labelled placeholder, and it hides that a conversation
  happened at all.
- **Applied server-side.** The client cannot forget to check.

Suggested client copy: _"This message was sent before you added this device."_
For the group as a whole, use `historyAvailableFromEpoch` to show a single
divider rather than repeating the notice on every message.

## Sending group messages

An MLS group message carries one ciphertext encrypted to the group's epoch
secrets, and the sender includes `mlsEpoch` on the send:

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "contentType": "text",
  "ciphertext": "base64",
  "mlsEpoch": 8
}
```

When `mlsEpoch` is present the per-device envelope rules do not apply — there is
one ciphertext for the whole group, not one per recipient device. Sending
`envelopes` alongside `mlsEpoch` is rejected: mixing the two key-distribution
models on a single message leaves recipients with no unambiguous rule for which
ciphertext to decrypt. The sibling-device coverage check (#188) is likewise
skipped, since a group ciphertext already reaches every device in the tree.

## Implementation references

- schema: `apps/backend/src/db/schema.ts` (`mlsGroups`, `mlsGroupMembers`, `mlsCommits`, `mlsWelcomes`)
- migration: `apps/backend/drizzle/0001_mls_group_state.sql`
- group state service: `apps/backend/src/services/mlsGroups.ts`
- epoch visibility rule: `apps/backend/src/lib/mlsVisibility.ts`
- routes: `apps/backend/src/routes/mls.ts`
- history read paths: `apps/backend/src/routes/conversations.ts`, `apps/backend/src/socket/messaging.ts`
- tests: `apps/backend/src/__tests__/mls.routes.test.ts`, `mlsGroups.service.test.ts`, `mlsVisibility.test.ts`, `mls.history.test.ts`
