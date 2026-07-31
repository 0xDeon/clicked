# Gateway Architecture: WebSocket Connection Management, Room Semantics, and Horizontal Scaling

## Overview

The gateway (`apps/backend/src/index.ts`) is a Socket.IO server that manages persistent WebSocket connections from authenticated devices. It provides:

- Real-time message delivery and events
- Cross-device synchronization
- Ephemeral event replay on reconnect
- Per-socket rate limiting and backpressure management
- Horizontal scaling via Redis pub/sub

This document explains the structural pieces that compose the gateway, their responsibilities, and the rationale behind key design decisions.

---

## 1. Connection Lifecycle

### 1.1 Authentication (`apps/backend/src/middleware/socketAuth.ts`)

Every connection passes through `socketAuthMiddleware` which:

1. Extracts a JWT from `socket.handshake.auth.token`
2. Verifies the JWT signature and extracts the payload (`userId`, `walletAddress`, `deviceId`)
3. Checks the device exists in PostgreSQL and is not revoked
4. Sets `socket.auth` with the verified `JwtPayload`
5. Sets `socket.identityPublicKey` from the device row

If any step fails, the connection is rejected with an `error` event and `next(new Error(...))`.

### 1.2 Connection Setup (`apps/backend/src/index.ts` lines 150-260)

After authentication, the server performs the following setup in order:

1. **Register device for revocation tracking** — subscribes to per-device Redis pub/sub channel so mid-session device revocation can force-disconnect
2. **Start heartbeat watchdog** — 90-second timeout; disconnects if no `heartbeat` event received
3. **Update `devices.lastSeenAt`** in PostgreSQL
4. **Install per-socket middleware**:
   - Event filter — excludes internal events (`heartbeat`) from downstream handlers
   - Device revocation check — rejects events if device was revoked mid-session
   - Payload size check — enforces `MAX_PAYLOAD_SIZE` (16 KB)
   - Rate limiting — enforces `SOCKET_RATE_LIMIT_PER_SEC` (10 events/sec)
5. **Join device room** (`device:${deviceId}`) — for per-device delivery
6. **Join user room** (`room:user:${userId}`) — for cross-device sync
7. **Auto-join conversation rooms** — queries `conversation_members` from PostgreSQL and joins each `room:conversation:${id}`
8. **Register Redis presence** — sets online status, cleans stale sockets, emits presence to co-members
9. **Register heartbeat handler** — responds to `heartbeat` events
10. **Register messaging handlers** — all WS event handlers via `registerMessagingHandlers(io, socket)`
11. **Subscribe to per-device Redis delivery channel** — for receiving envelopes published by other nodes
12. **Register for backpressure monitoring** — periodic `bufferedAmount` checks
13. **Install disconnect handler** — cleanup timers, rooms, presence, device channels

### 1.3 Shutdown (`apps/backend/src/index.ts` lines 330-410)

On `SIGTERM`/`SIGINT`:

1. Stop accepting new connections
2. Drain active sockets with a configurable grace period
3. Call `io.close()` and `httpServer.close()`
4. Clean up Redis pub/sub subscriptions
5. Exit

---

## 2. Room Architecture (`apps/backend/src/services/roomManager.ts`)

### 2.1 Room Types

| Room Pattern | Purpose | Membership Source |
|---|---|---|
| `room:conversation:${conversationId}` | Fan-out for conversation events (messages, typing, read receipts) | PostgreSQL `conversation_members` |
| `room:user:${userId}` | Cross-device synchronization (presence, delivery receipts) | Authenticated user ID |
| `device:${deviceId}` | Per-device delivery (message envelopes) | Authenticated device ID |

**Conversation rooms** are the primary broadcast channel. When a message is sent, the event is emitted to the conversation room, which reaches all online members across all nodes (via the Redis adapter).

**User rooms** span all devices owned by a user. Used for events that should reach every device: presence changes, cross-device sync signals, and delivery receipts.

**Device rooms** are 1:1 with a socket connection. Used for delivering encrypted message envelopes that only that specific device can decrypt.

### 2.2 Membership Validation

Room membership is **not trusted from room state alone**. Every `join_room` request re-validates against PostgreSQL:

```typescript
// src/services/roomManager.ts
async function joinConversationRoom(socket, conversationId) {
  const isValid = await validateConversationMembership(
    socket.auth.userId,
    conversationId
  );
  if (!isValid) {
    socket.emit("error", { message: "Not a member of this conversation" });
    return;
  }
  socket.join(conversationRoom(conversationId));
}
```

This is a defence-in-depth measure. While the client should only present valid memberships, the server never assumes room state is authoritative. The database is the source of truth.

### 2.3 Room Rebuild After Restart

When the gateway restarts, Socket.IO's Redis adapter does not persist room memberships. `rebuildRoomsAfterRestart()` queries all active conversation members from PostgreSQL and re-creates the in-memory room state. This runs once during boot.

### 2.4 Event Emitters

RoomManager provides typed emitters for common events:

- `emitTypingIndicator(conversationId, userId)` — broadcasts to conversation room
- `emitTypingStop(conversationId, userId)` — broadcasts to conversation room
- `emitPresenceUpdate(userId, status)` — broadcasts to user room (cross-device)
- `emitCrossDeviceEvent(userId, event)` — broadcasts to user room

---

## 3. Event Dispatch (`apps/backend/src/socket/dispatcher.ts`)

The `EventDispatcher` class provides a unified routing layer for incoming WebSocket events.

### 3.1 Dispatch Flow

1. Client sends `dispatch` event with an `EventEnvelope` payload
2. Dispatcher validates against `EventEnvelopeSchema` (Zod)
3. Checks `isKnownEventType(event.type)` — unknown types are rejected
4. Route to registered handler based on `event.type`
5. Handler processes the event and optionally emits acknowledgements

### 3.2 Idempotency

Redis SET NX with 24-hour TTL on `event:idempotency:${eventId}` prevents duplicate processing. If the same `eventId` arrives within 24 hours, it is silently dropped.

### 3.3 Ack

On successful processing, the server emits `dispatch_ack` with the `eventId`. This lets clients know the event was received and processed.

---

## 4. Message Delivery Pipeline (`apps/backend/src/services/deliveryPipeline.ts`)

### 4.1 Flow

1. **Persist** — Message is written to PostgreSQL via the database layer
2. **Resolve members** — Query active members from `conversation_members`
3. **Resolve devices** — For each member, find active (non-revoked) devices
4. **Load envelopes** — Load persisted envelopes from the database
5. **Fan-out per device** — Emit `message_envelope` to each `device:${id}` room
6. **Broadcast to conversation** — Emit `new_message` to `room:conversation:${id}` (omitting ciphertext for members who received envelope directly)

### 4.2 Persist-Before-Deliver

The database write completes before any socket emit. This ensures:

- Delivery can be re-attempted on failure
- Newly-connecting devices can sync missed messages
- The message ordering in the database matches the order clients observe

---

## 5. Ephemeral Event Replay (`apps/backend/src/services/resumeStream.ts`)

### 5.1 Purpose

Non-durable events (read receipts, delivery receipts, presence changes, system notices) are **not** persisted in the main message table. They are ephemeral: useful in real-time but not needed for long-term history.

When a device reconnects after a brief disconnect (e.g., network blip), it would miss these ephemeral events. The resume stream fills this gap.

### 5.2 Implementation

- **Storage**: Redis stream per user (`resume:events:${userId}`)
- **TTL**: 300 seconds (5 minutes) — configurable via `RESUME_STREAM_TTL_SECONDS` env var
- **Max length**: 500 entries — configurable via `RESUME_STREAM_MAXLEN` env var
- **Event types**: Read receipts, delivery receipts, presence changes, system notices only
- **Durable messages** are NEVER written to the resume stream — they are recovered via envelope sync on reconnect

### 5.3 Replay Flow

1. Client sends `resume` event with optional `cursor` (stream entry ID)
2. Server reads `XREAD` from the cursor position (or from the beginning if no cursor)
3. Events are replayed in order to the client
4. Client processes each event (mark as read, update delivery state, etc.)

### 5.4 Bounding

Stream length is capped at 500 entries. Old entries are trimmed automatically. The TTL of 300 seconds bounds the maximum disconnection duration for which replay is available.

---

## 6. Presence Tracking (`apps/backend/src/services/presence.ts`)

Redis-based presence with these key patterns:

| Key Pattern | Type | Purpose |
|---|---|---|
| `presence:user:${userId}` | Hash | `deviceId → lastSeen` timestamp |
| `presence:user:${userId}:device:${deviceId}` | String | Per-device key with 90s TTL |
| `presence:sockets:${userId}` | Set | Active socket IDs |
| `presence:socket:${socketId}` | Hash | `{ userId, deviceId }` mapping |

### 6.1 Boot Reconciliation

On startup, `reconcileBoot()` scans all presence keys and removes stale entries (sockets that were disconnected during the previous process's lifetime but whose Redis presence keys were not cleaned up).

---

## 7. Rate Limiting (`apps/backend/src/services/rateLimit.ts`)

| Parameter | Default | Env Variable | Behavior |
|---|---|---|---|
| Events per second | 10 | `SOCKET_RATE_LIMIT_PER_SEC` | Redis `INCR` + `EXPIRE 1` per socket |
| Max payload size | 16384 bytes (16 KB) | `MAX_PAYLOAD_SIZE` | Checked before handler execution |
| Violation threshold | 3 | (hardcoded) | In-memory counter; disconnect on 3rd violation |

### 7.1 Per-Socket Limiting

Rate limits are applied per-socket (not per-user). Each socket has an independent counter keyed by `socket.id`. The counter resets every second.

### 7.2 Payload Caps

The raw message payload is size-checked before any processing. If it exceeds `MAX_PAYLOAD_SIZE`, the event is rejected with an error and the violation counter increments.

---

## 8. Backpressure (`apps/backend/src/services/backpressure.ts`)

Monitors the WebSocket send buffer (`socket.io`'s `bufferedAmount`) to detect slow consumers.

| Threshold | Default | Env Variable | Action |
|---|---|---|---|
| Shed | 32768 bytes | `SOCKET_SHED_THRESHOLD` | Stop sending new events to this socket |
| Disconnect | 65536 bytes | `SOCKET_BUFFER_THRESHOLD` | Force-disconnect the socket |

### 8.1 Monitoring

Every 5 seconds, `registerForBackpressure` checks `socket.bufferedAmount`. If the shed threshold is exceeded, the socket is marked as "shed" and no further events are sent until the buffer drains. If the disconnect threshold is exceeded, the socket is force-disconnected.

### 8.2 Use Case

A client on a slow network connection accumulates a backlog of unsent events in the send buffer. Without backpressure, the server would keep buffering indefinitely, consuming memory. Backpressure provides a circuit-breaker.

---

## 9. Device Revocation (`apps/backend/src/services/deviceRevocation.ts`)

When a device is revoked (user logs out, admin removes device), the server must force-disconnect the active socket.

### 9.1 Cross-Node Revocation

1. Revocation is published to Redis pub/sub channel `device:revoked:${deviceId}`
2. All gateway nodes subscribe to this channel via the connection setup step
3. On receiving a revocation message, the node finds the socket for that device and disconnects it

### 9.2 Mid-Session Check

A per-socket middleware checks if the device has been revoked on every event. If the device was revoked but the disconnect message was missed (e.g., Redis pub/sub delivery failure), the next event from that socket will trigger a check against PostgreSQL and force-disconnect.

---

## 10. Horizontal Scaling

### 10.1 Redis Adapter

The gateway uses `@socket.io/redis-adapter` with two Redis clients:

- **Pub client** — publishes events to Redis
- **Sub client** — subscribes to events from other nodes

When a socket on Node A emits to a room, the event is published to Redis. Node B's sub client receives the event and delivers it to sockets on Node B that are members of that room.

### 10.2 Per-Device Delivery Channel

For message envelopes (which must reach a specific device, not a room), each device subscribes to a Redis pub/sub channel `device:${deviceId}` during connection setup. This enables cross-node delivery of encrypted envelopes.

### 10.3 Startup Room Rebuild

On restart, `rebuildRoomsAfterRestart()` re-populates room membership from PostgreSQL. This is necessary because Redis adapter does not persist room state across process restarts.

---

## 11. Key Design Decisions

### Why re-validate membership from Postgres rather than trusting room state?

Room state in Socket.IO is ephemeral and in-memory. A compromised client could attempt to join a room it should not have access to. By re-validating against PostgreSQL on every `join_room` event, the server ensures the database is the authoritative source of membership.

Additionally, members may be added or removed from conversations while the gateway is running. Room state would reflect the membership at connection time, which may be stale.

### Why use Redis streams for ephemeral events rather than the message table?

The message table stores durable, encrypted message data. Ephemeral events (read receipts, typing indicators, presence) are high-volume, low-value-after-seconds data. Writing them to the message table would:

- Increase write pressure on PostgreSQL
- Bloat the message table with transient data
- Require additional filtering logic to separate ephemeral from durable events

Redis streams are purpose-built for this: fast writes, automatic TTL, and bounded size.

### Why separate rate limit and payload cap into a dedicated service?

Rate limiting touches every event. By isolating it in `rateLimit.ts`, the implementation can be:

- Tested independently from event handlers
- Swapped (e.g., token bucket instead of fixed-window) without touching messaging code
- Audited for correctness without understanding the full gateway flow

### Why are shed/disconnect thresholds separate?

Shedding (stop sending) is reversible — when the buffer drains, normal delivery resumes. Disconnection is terminal and requires the client to reconnect. Having separate thresholds means the server can back off aggressively (shed at 32 KB) while still giving the client a chance to recover before being disconnected (64 KB).

---

## 12. Configuration Reference

| Env Variable | Default | Service | Description |
|---|---|---|---|
| `SOCKET_RATE_LIMIT_PER_SEC` | `10` | rateLimit | Max events per second per socket |
| `MAX_PAYLOAD_SIZE` | `16384` | rateLimit | Max event payload size in bytes |
| `RESUME_STREAM_TTL_SECONDS` | `300` | resumeStream | TTL for ephemeral event stream |
| `RESUME_STREAM_MAXLEN` | `500` | resumeStream | Max entries in ephemeral event stream |
| `SOCKET_SHED_THRESHOLD` | `32768` | backpressure | Buffer size at which to stop sending |
| `SOCKET_BUFFER_THRESHOLD` | `65536` | backpressure | Buffer size at which to disconnect |

---

## 13. Related Documentation

- [E2EE Onboarding Flow](./e2ee-onboarding.md) — Key bundle exchange and device registration
- [Signal Integration](../../../docs/signal-integration.md) — End-to-end encryption layer
- Gateway integration tests: `src/__tests__/integration/gateway.integration.test.ts`
