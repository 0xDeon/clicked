# Group epoch sync and system events

Group state — who is a member, whose keys are current — is only usable if every
client applies the same changes in the same order. This document describes the
ordered group-control log that makes that true, and how a client that missed
commits catches up.

Implementation: `apps/backend/src/services/groupControl.ts`, the
`group_control_events` table and `conversations.epoch`, migration
`0001_group_control_events.sql`.

## Why a separate log

Chat messages are ordered by `(createdAt, id)`. That is fine for a timeline,
but wrong for group control:

- A client that applies a join and a leave in the wrong order derives a
  different key schedule and can no longer decrypt.
- A timestamp cursor can silently _skip_ an event written slightly out of clock
  order — and a skipped membership change is indistinguishable, to the client,
  from no change at all.

So group control gets its own log with a strictly monotonic, gap-free
`sequence` per conversation. "Am I behind?" becomes an integer comparison, and
"catch me up" becomes `sequence > mine`, which cannot skip.

## The log

| Column                         | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `sequence`                     | Strictly increasing from 1, gap-free within a conversation      |
| `epoch`                        | The group epoch **after** this event was applied                |
| `eventType`                    | `member_added`, `member_removed`, `member_left`, `commit`       |
| `actorUserId` / `targetUserId` | Who made the change, and who it was about                       |
| `messageId`                    | The `content_type='system'` message emitted for the same event  |
| `payload`                      | Opaque client-supplied MLS material, never parsed by the server |

Because `epoch` is the value _after_ the event, a client compares its own epoch
against the newest row and knows exactly how far behind it is.

### Ordering under concurrency

`conversations.epoch` is bumped with `UPDATE ... RETURNING` inside the same
transaction that assigns the sequence. That update takes a row lock on the
conversation, so a concurrent join and leave are forced into a real order
rather than racing for the same sequence number. The unique index on
`(conversationId, sequence)` is the backstop, not the mechanism.

### Atomicity with the membership change

The membership row and its control event are written in one transaction. A
member committed without the epoch bump that announces them would leave every
other client unaware of someone who can now decrypt — precisely the divergence
this log exists to prevent. The live broadcast happens only after the commit,
so a client reacting to the event always finds the membership already in place.

## System events

Every control event also persists a `content_type='system'` message, so the
change appears in the conversation timeline alongside chat. Its body is one
stable shape:

```json
{
  "type": "group_control",
  "eventType": "member_added",
  "conversationId": "…",
  "epoch": 4,
  "sequence": 7,
  "actorUserId": "…",
  "targetUserId": "…"
}
```

Like the existing device-change system messages, this is stored unencrypted and
contains no private content — only who changed what, and the resulting epoch.

Live, each event is fanned out to the conversation room as:

- `group_system_event` — the full control event.
- `epoch_changed` — `{ conversationId, epoch, sequence }`, for clients that
  only need to know they must reconcile.
- `new_message` — the system message, so existing timeline rendering picks it
  up with no client change.

Both the optimized fan-out room and the plain conversation id receive them, in
line with how the rest of the gateway emits.

## Catching up

### Am I behind?

```
GET /conversations/:id/epoch
→ { "conversationId": "…", "epoch": 4, "latestSequence": 7 }
```

Compare `latestSequence` against the last sequence you applied.

### Fetch what you missed, in order

```
GET /conversations/:id/group-control?sinceSequence=<n>&limit=<n>

→ {
    "conversationId": "…",
    "currentEpoch": 4,
    "latestSequence": 7,
    "events": [ … ],      // ascending by sequence — the order to replay in
    "nextSequence": 7,    // feed straight back as sinceSequence
    "hasMore": false
  }
```

`sinceSequence` is **exclusive**, so replaying with the same cursor never
re-applies an event you already have. Omit it to fetch the whole log — the path
a client takes on first sync or after a long absence. Page size defaults to 100
and is clamped to 500.

`currentEpoch` and `latestSequence` describe where the group is _now_, so a
client can tell whether this page finished the catch-up even before it looks at
`hasMore`.

The result: a client that replays the log from 0 and a client that saw every
event live end up on the same epoch, because both applied the same events in
the same order.

### Submitting a commit

```
POST /conversations/:id/group-control
{ "payload": "<opaque MLS commit>" }

→ 201 { "sequence": 8, "epoch": 5, "eventType": "commit", … }
```

Members only. The payload is opaque to the server — it is stored and relayed
byte for byte, capped at 64 KiB. The server sequences group control; it does
not interpret it.

## Membership changes that emit events

| Route                                   | Event          |
| --------------------------------------- | -------------- |
| `POST /conversations/:id/members`       | `member_added` |
| `DELETE /conversations/:id/leave`       | `member_left`  |
| `POST /conversations/:id/group-control` | `commit`       |

The response to a join now also carries the resulting `epoch` and `sequence`,
so the caller does not need a follow-up request to learn where the group
landed.

One case emits nothing: the **last** member leaving. That deletes the
conversation, and the control log with it, so there is nobody left to reconcile
and nothing to reconcile against.
