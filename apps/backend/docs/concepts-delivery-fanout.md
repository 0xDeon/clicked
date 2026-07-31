# Per-device delivery, fan-out & receipts pipeline

This document describes how a sent message reaches every recipient device today, and how delivery/read receipts flow back to the sender. It is written against the code as it currently behaves, not the intended design — several pieces exist in the codebase but are not wired into the live send path, and those gaps are called out explicitly.

It covers:

1. what each of `services/fanout.ts`, `services/deliveryPipeline.ts`, `services/deliveryAggregation.ts` and `services/deviceDelivery.ts` is responsible for
2. a step-by-step trace of one message from `send_message` through to every recipient device's delivery receipt reaching the sender
3. how read receipts differ from delivery receipts
4. what is and isn't wired into the live send path

## Actors

- **Sender client**: the device that emits `send_message`
- **Recipient device(s)**: every active (non-revoked) device belonging to every member of the conversation
- **Backend gateway**: the Socket.IO server in `apps/backend/src/index.ts`, potentially one of several instances behind the Redis adapter

## Service responsibilities

### `services/deliveryPipeline.ts` — the live fan-out engine

Given an already-persisted message, loads the conversation's current active devices and delivers a per-device `message_envelope` event to each one that has a matching ciphertext envelope, plus a ciphertext-free `new_message` event to the conversation room for UI/unread-count purposes. This is the only service actually called from `send_message`/`edit_message`.

### `services/deliveryAggregation.ts` — receipt aggregation

Tracks per-device delivery acknowledgements (`messageEnvelopes.deliveredAt`), determines when a recipient user's entire active device set has received a message, and notifies the sender via `message_fully_delivered` when that happens. It also emits a per-device `device_delivery_receipt` to the whole conversation on every ack, independent of full-delivery status.

### `services/fanout.ts` — not wired into the live send path

Implements a stronger fan-out guarantee: validating that the sender-supplied envelope map covers every other conversation member's active devices (not just the sender's own), and persisting the message + envelopes atomically. It is fully implemented and exported (`fanoutMessage`) but has no callers anywhere in the backend and no test exercises it — see [Gaps](#gaps--code-not-wired-into-the-live-path) below.

### `services/deviceDelivery.ts` — half-wired

Defines a Redis pub/sub channel per device (`deliver:device:${deviceId}`) intended as an alternate, cross-gateway-instance delivery path. The *subscribe* side (`GatewayDeviceSubscriber`) is booted for every connected socket and would forward anything published on that channel as a `device_envelope` event — and the web client does listen for `device_envelope` (`apps/web/src/hooks/useInboundPipeline.ts:257`). But the *publish* side (`publishToDevice`) has no production callers, so nothing ever actually flows through this channel today.

## Step-by-step trace: `send_message` → every device → receipt back to sender

All of this happens inside `apps/backend/src/socket/messaging.ts`, wired up per-connection from `apps/backend/src/index.ts`.

**1. Connection setup** — on `io.on('connection', ...)`, each socket joins a `` `device:${deviceId}` `` room (this is the exact room `deliveryPipeline.ts`'s `deviceRoom()` targets), the user's own `` `room:user:${userId}` `` room, and every conversation room it belongs to. `registerMessagingHandlers` then wires up the event handlers below.

**2. Client emits `send_message`** — the handler in `socket/messaging.ts`:
   - clears typing timers for the conversation
   - validates `messageId`, `contentType`, `ciphertext`/`envelopes`/`fileId` via `validateMessagePayload`
   - verifies sender conversation membership
   - short-circuits (re-emits `message_ack`) if the message id already exists (idempotency)
   - checks that the sender supplied envelopes for all of their **own** other active devices (`fetchSiblingDeviceIds`) — note this only covers the sender's sibling devices, not every recipient's devices (see gaps below)
   - persists the `messages` row and the per-recipient-device `messageEnvelopes` rows in one transaction
   - emits `message_ack` back to the sender
   - calls `deliverMessage(io, message, conversationId)` — the hand-off into fan-out

**3. Fan-out — `deliveryPipeline.ts`'s `deliverMessage`**:
   - re-queries `conversationMembers` for the conversation (source of truth, not room state)
   - loads active (non-revoked) devices for those members
   - loads the envelopes just persisted, filtered to those active devices
   - for each active device with a matching envelope: emits `message_envelope` (with ciphertext) to `` io.to(`device:${deviceId}`) ``. Because every connected socket already joined that room at connect time, and the Socket.IO Redis adapter fans room emits across gateway instances, this reaches the recipient wherever it's connected
   - emits a ciphertext-free `new_message` to the conversation room(s) for UI/unread-count updates

**4. Offline fallback** — after `deliverMessage` returns, `send_message` invalidates conversation-list caches and fires `dispatchOfflinePush` for any recipient device with no live socket connection, queuing a Web Push notification. This path is independent of the Socket.IO fan-out and never touches `messageEnvelopes.deliveredAt`.

**5. Recipient acks receipt — `message_delivered`** — when a recipient device receives `message_envelope`, its client emits `message_delivered` with `{conversationId, messageId, envelopeId, sequenceNumber}`. The handler validates required fields and membership, then calls `handleDeviceDeliveryReceipt(io, redis, messageId, recipientDeviceId, recipientUserId, conversationId)`.

**6. Aggregation — `deliveryAggregation.ts`'s `handleDeviceDeliveryReceipt`**:
   - looks up the message's `senderId`
   - short-circuits if this device's envelope is already marked delivered (idempotency)
   - sets `messageEnvelopes.deliveredAt = now()` for `(messageId, recipientDeviceId)`
   - checks `isMessageFullyDeliveredToUser`: whether every active device belonging to that recipient user now has `deliveredAt` set
   - **if fully delivered**: emits `message_fully_delivered` to `` `room:user:${senderId}` `` — this is the moment a delivery receipt actually reaches the sender for full multi-device delivery — and republishes it over Redis (`publishEphemeral`) so it survives replay if the sender wasn't connected at that instant
   - **always**: also emits a per-device `device_delivery_receipt` to the whole conversation room (`.volatile`), visible to all members, not just the sender

**7. Read receipts are a separate, simpler mechanism** (see below) and never touch `deliveryAggregation.ts` or `messageEnvelopes`.

```text
Sender          Backend (send_message)      deliveryPipeline           Recipient device(s)        deliveryAggregation
  |--send_message------->|                          |                          |                          |
  |<--message_ack---------|                          |                          |                          |
  |                       |--deliverMessage--------->|                          |                          |
  |                       |                          |--message_envelope------->|                          |
  |                       |                          |--new_message (no ct)---->| (conversation room)     |
  |                       |                          |                          |--message_delivered------------------->|
  |                       |                          |                          |                          |--sets deliveredAt
  |<---message_fully_delivered (once all devices ack)-------------------------------------------------------|
  |          (also) <--device_delivery_receipt to conversation room, per device ack-----------------------|
```

## Read receipts vs. delivery receipts

Read receipts are conversation-level, not per-device: the `message_read` handler updates a single `conversationMembers.lastReadMessageId` cursor per `(conversationId, userId)` and broadcasts `read_receipt` to the whole conversation room. There is no per-envelope/per-device read tracking and no "fully read by all devices" concept analogous to `message_fully_delivered` — delivery tracks per-device state via `messageEnvelopes.deliveredAt`; reads do not have an equivalent per-device column that's actually used.

## Gaps — code not wired into the live path

- **`fanoutMessage` (`services/fanout.ts`) has zero callers.** The live `send_message` handler only validates the sender's own sibling devices via `fetchSiblingDeviceIds`, not the full "every recipient's active devices are covered" guarantee that `fanoutMessage` implements.
- **`publishToDevice` (`services/deviceDelivery.ts`) has zero callers.** Its subscribe side is booted on every connection, but nothing publishes to `deliver:device:${deviceId}` in production — the room-based delivery in `deliveryPipeline.ts` is what actually runs.
- **`getMessageDeliveryStatus` (`services/deliveryAggregation.ts`) has zero callers** outside its own test — no route or handler exposes a delivery-status read model.
- **`POST /messages` (REST route) bypasses the fan-out pipeline entirely.** It persists the message/envelopes and does a bare `new_message` room emit, but never calls `deliverMessage` or `dispatchOfflinePush` — clients sending via REST get no per-device envelope push and no offline Web Push fallback.
- **`device_delivery_receipt` is emitted twice per `message_delivered` call** — once from `deliveryAggregation.ts` and once again from `socket/messaging.ts`'s own handler — to the same conversation room.
- **`messageEnvelopes.readAt` and `users.sendReadReceipts` exist in the schema but are never read or written** anywhere in the backend.

## Implementation references

- `apps/backend/src/socket/messaging.ts` — `send_message`, `message_delivered`, `message_read`, `edit_message` handlers
- `apps/backend/src/services/deliveryPipeline.ts` — per-device fan-out (`deliverMessage`, `deviceRoom`)
- `apps/backend/src/services/deliveryAggregation.ts` — receipt aggregation (`handleDeviceDeliveryReceipt`, `isMessageFullyDeliveredToUser`, `getMessageDeliveryStatus`)
- `apps/backend/src/services/fanout.ts` — unused stronger fan-out validation (`fanoutMessage`)
- `apps/backend/src/services/deviceDelivery.ts` — Redis pub/sub per-device channel (`publishToDevice`, `GatewayDeviceSubscriber`)
- `apps/backend/src/services/pushNotification.ts` — offline Web Push fallback (`dispatchOfflinePush`)
- `apps/backend/src/index.ts` — connection setup, device/user/conversation room joins, Redis adapter attachment
- `apps/backend/src/routes/messages.ts` — REST send path that bypasses `deliveryPipeline.ts`
- See [`e2ee-onboarding.md`](./e2ee-onboarding.md) for how envelopes/ciphertext are constructed client-side before `send_message` is emitted.
