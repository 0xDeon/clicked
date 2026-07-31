import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Central registry of all valid socket event types.
export const KNOWN_EVENT_TYPES = new Set([
  // Inbound (client → server)
  'auth',
  'heartbeat',
  'join_room',
  'send_message',
  'edit_message',
  'send_file_message',
  'file_message',
  'message_history',
  'delete_message',
  'message_read',
  'message_delivered',
  'create_conversation',
  'typing_start',
  'typing_stop',
  'ask_assistant',
  'resume',
  'join_device_channel',
  // Outbound (server → client) — registered so the registry is the single source of truth
  'room_joined',
  'new_message',
  'message_ack',
  'message_deleted',
  'message_edited',
  'read_receipt',
  'delivery_receipt',
  'device_delivery_receipt',
  'conversation_created',
  'ephemeral_replay',
  'resume_complete',
  'device_envelope',
  'presence',
  'presence_update',
  'user_online',
  'user_offline',
  'device_revoked',
  'dispatch_ack',
  'rate_limited',
  'payload_too_large',
  'message_envelope',
  'error',
]);

export const EventEnvelopeSchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  type: z.string().min(1, 'type is required'),
  timestamp: z.number().int().positive('timestamp must be a positive integer'),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

export function createEnvelope(
  type: string,
  payload: Record<string, unknown>,
  eventId?: string,
): EventEnvelope {
  return {
    eventId: eventId ?? randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}
