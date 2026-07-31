# WebSocket Contracts & Payloads

This document serves as the strict schema reference for WebSocket communication in the backend, defining the structure of the event envelope, the registered known event types, and the exact payload shape expected by each event handler.

## 1. Event Envelope (`EventEnvelopeSchema`)

All events dispatched via the `EventDispatcher` must be wrapped in a standard envelope. The structure is defined in `lib/eventEnvelope.ts`.

```typescript
{
  eventId: string;     // Required (min 1). Unique identifier for the event.
  type: string;        // Required (min 1). The event type name.
  timestamp: number;   // Required. Positive integer representing the time of the event.
  payload: Record<string, unknown>; // Optional. Defaults to {}. Contains the event-specific data.
}
```

## 2. Known Event Types (`KNOWN_EVENT_TYPES`)

The central registry of valid socket event types, as defined in `lib/eventEnvelope.ts`.

**Inbound (Client → Server):**
- `join_room`
- `send_message`
- `message_history`
- `delete_message`
- `message_read`
- `create_conversation`
- `typing_start`
- `typing_stop`
- `ask_assistant`
- `resume`
- `join_device_channel`

**Outbound (Server → Client):**
- `room_joined`
- `new_message`
- `message_ack`
- `message_deleted`
- `read_receipt`
- `conversation_created`
- `ephemeral_replay`
- `resume_complete`
- `device_envelope`
- `error`

## 3. Inbound Event Payload Schemas

The following are the precise payload shapes expected by the handlers in `socket/messaging.ts`. These schemas correspond to the `payload` property of the `EventEnvelope`.

### `join_room`
```typescript
{
  conversationId: string;
}
```

### `send_message`
```typescript
{
  conversationId: string;
  messageId?: string;
  content?: string;
  contentType?: string;
  ciphertext?: string;
  envelopes?: Array<{
    recipientDeviceId: string;
    ciphertext: string;
  }>;
  fileId?: string;
}
```

### `edit_message`
```typescript
{
  originalMessageId: string;
  messageId: string;
  contentType?: string;
  ciphertext?: string;
  envelopes?: Array<{
    recipientDeviceId: string;
    ciphertext: string;
  }>;
}
```

### `send_file_message`
*Note: Handled directly via `socket.on`, not wrapped in the standard `EventDispatcher` envelope.*
```typescript
{
  conversationId: string;
  fileId: string;
  content: string;
  contentType: 'file' | 'image' | 'video' | 'audio';
}
```

### `message_history`
```typescript
{
  conversationId: string;
  before?: string;
}
```

### `delete_message`
```typescript
{
  messageId: string;
}
```

### `message_read`
```typescript
{
  conversationId: string;
  lastReadMessageId: string;
}
```

### `message_delivered`
```typescript
{
  conversationId?: string;
  messageId?: string;
  envelopeId?: string;
  sequenceNumber?: number;
}
```

### `resume`
```typescript
{
  lastEventId?: string;
}
```

### `create_conversation`
```typescript
{
  type: 'dm' | 'group';
  name?: string;
  memberIds: string[];
}
```

### `typing_start`
```typescript
{
  conversationId: string;
  deviceId?: string;
}
```

### `typing_stop`
```typescript
{
  conversationId: string;
  deviceId?: string;
}
```

### `ask_assistant`
```typescript
{
  conversationId: string;
  content: string;
}
```

## 4. Known Discrepancies

The following event types are currently handled by socket listeners in `socket/messaging.ts`, but are **missing** from `KNOWN_EVENT_TYPES` in `lib/eventEnvelope.ts`:

- `edit_message`
- `send_file_message`
- `message_delivered`
