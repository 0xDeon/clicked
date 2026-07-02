import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { conversationMembers, messageEnvelopes, userDevices } from '../db/schema.js';
import type { Message } from '../db/schema.js';

/**
 * Room name for per-device targeting. Each socket joins this room on connect
 * so that io.to(deviceRoom(id)) reaches exactly that device across all instances
 * via the Redis adapter.
 */
export function deviceRoom(deviceId: string): string {
  return `device:${deviceId}`;
}

/**
 * Deliver a persisted message to every active recipient device.
 *
 * Order of operations (persist-before-deliver is guaranteed by callers):
 *   1. Re-validate members from conversation_members (not from room state).
 *   2. Resolve active (non-revoked) devices for those members.
 *   3. Load persisted envelopes — only devices that have one get delivered.
 *   4. Emit message_envelope to each device's scoped room with its ciphertext.
 *   5. Emit new_message to the conversation room so clients update their UI.
 */
export async function deliverMessage(
  io: Server,
  message: Message,
  conversationId: string,
): Promise<void> {
  // Step 1: re-validate membership from the source of truth.
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  if (members.length === 0) return;

  const userIds = members.map((m) => m.userId);

  // Step 2: active devices only — revokedAt IS NULL.
  const activeDevices = await db
    .select({ id: userDevices.id, userId: userDevices.userId })
    .from(userDevices)
    .where(and(inArray(userDevices.userId, userIds), isNull(userDevices.revokedAt)));

  if (activeDevices.length === 0) {
    io.to(conversationId).emit('new_message', message);
    return;
  }

  const activeDeviceIds = activeDevices.map((d) => d.id);

  // Step 3: load envelopes already committed to the database.
  const envelopes = await db
    .select({
      id: messageEnvelopes.id,
      recipientDeviceId: messageEnvelopes.recipientDeviceId,
      ciphertext: messageEnvelopes.ciphertext,
    })
    .from(messageEnvelopes)
    .where(
      and(
        eq(messageEnvelopes.messageId, message.id),
        inArray(messageEnvelopes.recipientDeviceId, activeDeviceIds),
      ),
    );

  const envelopeByDevice = new Map(envelopes.map((e) => [e.recipientDeviceId, e]));

  // Step 4: push each device exactly its envelope.
  for (const device of activeDevices) {
    const envelope = envelopeByDevice.get(device.id);
    if (!envelope) continue;

    io.to(deviceRoom(device.id)).emit('message_envelope', {
      messageId: message.id,
      conversationId,
      senderId: message.senderId,
      senderDeviceId: message.senderDeviceId,
      contentType: message.contentType,
      sequenceNumber: message.sequenceNumber,
      createdAt: message.createdAt,
      envelopeId: envelope.id,
      ciphertext: envelope.ciphertext,
    });
  }

  // Step 5: room-level notification so clients can update unread counts / UI.
  // Ciphertext is intentionally omitted here; each device received it above.
  io.to(conversationId).emit('new_message', {
    id: message.id,
    conversationId,
    senderId: message.senderId,
    senderDeviceId: message.senderDeviceId,
    contentType: message.contentType,
    sequenceNumber: message.sequenceNumber,
    createdAt: message.createdAt,
    deletedAt: message.deletedAt,
    ciphertext: null,
  });
}
