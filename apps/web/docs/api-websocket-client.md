# WebSocket Client Usage

This document explains the architecture and usage of the WebSocket client in the frontend, specifically covering `lib/socket.ts`, `lib/realtime.ts`, and `hooks/useSocket.ts`.

## Connection Setup and Lifecycle

Connections to the Socket.IO server are established via the `useSocket` hook or manually through `initSocket`. 

### Auth Handshake & Token Passing
The connection passes the user's authentication `token` and a unique End-to-End Encryption (E2EE) `deviceId` in the connection handshake.

```typescript
io(SOCKET_URL, {
  auth: { token, deviceId },
  transports: ['websocket'],
  reconnection: true,
})
```

- **Token Passing**: The JWT token and device ID are extracted and injected into the `auth` object on connection.
- **Reconnection Policy**: `reconnection: true` is configured out of the box, with `websocket` being the exclusive transport (polling is disabled).

### Reconnection and Resume Behavior
Upon successfully connecting (or reconnecting) via the `connect` event, the client emits a `resume` envelope containing the `lastEventId`. This `lastEventId` is tracked locally in `localStorage` (`clicked.socket.resumeCursor:*`) every time an event that supports resumption is received. This instructs the server to redeliver any missed socket events.

Additionally, after resuming, a fallback sync process (`runSocketSync` via an HTTP API endpoint) fetches missed envelopes since the last known `sequenceNumber`.

## The `emitSocketEnvelope` Convention

Instead of emitting raw socket events (e.g., `socket.emit('event_name', payload)`), the frontend enforces an envelope convention using the `emitSocketEnvelope` helper.

When `emitSocketEnvelope(socket, type, payload)` is called, it packages the request into a standard `EventEnvelope` containing:
- `eventId`: A unique UUID (`crypto.randomUUID()`).
- `type`: The actual event type (e.g., `'resume'`, `'message_delivered'`).
- `timestamp`: The timestamp of the emission.
- `payload`: The business data.

This envelope is then emitted as a single `'dispatch'` event over the wire:

```typescript
socket.emit('dispatch', envelope);
```

### Example Usage
```typescript
emitSocketEnvelope(socket, 'message_delivered', {
  conversationId: 'conv-123',
  messageId: 'msg-456',
  envelopeId: 'env-789',
  sequenceNumber: 1,
});
```

### Enveloped Events vs. Raw Events
Currently, **all** client-to-server emissions use the envelope pattern via the `'dispatch'` channel. There are no raw `socket.emit` calls for business events triggered by the frontend.

Events currently wrapped in the envelope to the server:
- `'resume'`
- `'message_delivered'`

*Note*: The server sends raw socket events to the client (e.g., `'new_message'`, `'message_envelope'`, `'connect'`, `'resume_complete'`).

## Event Listeners Map

The following table documents the inbound events the frontend listens for and which component or hook consumes them:

| Socket Event | Consumer(s) | Purpose |
|--------------|-------------|---------|
| `connect` | `hooks/useSocket.ts`, `lib/socket.ts` | Triggers the `resume` process and HTTP data sync. |
| `disconnect` | `lib/socket.ts` | Logs disconnect state. |
| `error` | `lib/socket.ts` | Logs socket errors. |
| `resume_complete` | `hooks/useSocket.ts`, `lib/socket.ts` | Updates the resume cursor and triggers HTTP sync if required. |
| `ephemeral_replay` | `hooks/useSocket.ts`, `lib/socket.ts` | Allows the server to trigger a replay of an ephemeral event locally. |
| `message_envelope` | `hooks/useSocket.ts`, `lib/socket.ts`, `hooks/useInboundPipeline.ts`, `app/conversations/[id]/page.tsx` | Acknowledges receipt of message envelopes by dispatching a `message_delivered` envelope. |
| `user_online` | `ConversationListSidebar.tsx` | Updates a user's presence state to online in the sidebar. |
| `user_offline` | `ConversationListSidebar.tsx` | Updates a user's presence state to offline in the sidebar. |
| `presence_update` | `ConversationListSidebar.tsx` | Updates arbitrary presence metadata in the sidebar. |
| `new_message` | `ConversationListSidebar.tsx`, `hooks/useInboundPipeline.ts`, `hooks/useMessageHistory.ts`, `MessageThread.tsx`, `app/conversations/[id]/page.tsx`, `app/app/conversations/[id]/page.tsx` | Appends a new message to the local chat view. |
| `device_envelope` | `hooks/useInboundPipeline.ts` | Receives key exchange or device synchronization events. |
| `message_history` | `hooks/useMessageHistory.ts`, `app/conversations/[id]/page.tsx` | Populates the initial chunk of message history for a conversation. |
| `message_ack` | `app/conversations/[id]/page.tsx` | Acknowledges the server processed an outgoing message. |
| `delivery_receipt` | `app/conversations/[id]/page.tsx` | Marks a message as delivered to a participant. |
| `read_receipt` | `app/conversations/[id]/page.tsx` | Marks a message as read by a participant. |
| `typing_start` | `MessageThread.tsx`, `app/conversations/[id]/page.tsx` | Displays a typing indicator. |
| `typing_stop` | `MessageThread.tsx`, `app/conversations/[id]/page.tsx` | Hides the typing indicator. |
| `treasury_proposal_updated` | `app/app/treasury/page.tsx` | Updates treasury UI when a proposal's status changes. |
