import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { conversationMembers, messageEnvelopes, devices } from '../db/schema.js';
import type { Message } from '../db/schema.js';
import { conversationRoom } from './roomManager.js';
import { isMlsWelcomeContentType, mlsWelcomeTransport } from '../lib/mls.js';
import { fanoutSize, deliveryLatency } from '../lib/metrics.js';

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
 *
 * MLS Welcome payloads use this same pipeline. Their ciphertext is never
 * inspected; the additional eventType only lets clients dispatch the payload
 * to their MLS implementation.
 */
export async function deliverMessage(
  io: Server,
  message: Message,
  conversationId: string,
): Promise<void> {
  const deliveryStart = process.hrtime.bigint();
  // Step 1: re-validate membership from the source of truth.
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  if (members.length === 0) return;

  // MLS Welcome messages ride the normal device-scoped delivery path but are
  // tagged so the client routes them to the group-join handler rather than the
  // timeline. The Welcome itself stays an opaque string.
  const welcomeTransport = isMlsWelcomeContentType(message.contentType)
    ? mlsWelcomeTransport()
    : null;

  const userIds = members.map((m) => m.userId);

  const activeDevices = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNull(devices.revokedAt)));

  if (activeDevices.length === 0) {
    io.to(conversationId).emit('new_message', message);
    io.to(conversationRoom(conversationId)).emit('new_message', message);
    return;
  }

  const activeDeviceIds = activeDevices.map((d) => d.id);

  const envelopes = await db
    .select({
      id: messageEnvelopes.id,
      recipientDeviceId: messageEnvelopes.recipientDeviceId,
      ciphertext: messageEnvelopes.ciphertext,
      protocol: messageEnvelopes.protocol,
    })
    .from(messageEnvelopes)
    .where(
      and(
        eq(messageEnvelopes.messageId, message.id),
        inArray(messageEnvelopes.recipientDeviceId, activeDeviceIds),
      ),
    );

  const envelopeByDevice = new Map(envelopes.map((e) => [e.recipientDeviceId, e]));
  fanoutSize.observe(envelopeByDevice.size);

  for (const device of activeDevices) {
    const envelope = envelopeByDevice.get(device.id);
    if (!envelope) continue;

    io.to(deviceRoom(device.id)).emit('message_envelope', {
      messageId: message.id,
      conversationId,
      senderId: message.senderId,
      senderDeviceId: message.senderDeviceId,
      contentType: message.contentType,
      createdAt: message.createdAt,
      envelopeId: envelope.id,
      ciphertext: envelope.ciphertext,
      // #364 — tells the receiving device which decryption path to use.
      protocol: envelope.protocol,
      ...(welcomeTransport ?? {}),
    });
  }

  const newMessageEvent = {
    id: message.id,
    conversationId,
    senderId: message.senderId,
    senderDeviceId: message.senderDeviceId,
    contentType: message.contentType,
    createdAt: message.createdAt,
    deletedAt: message.deletedAt,
    ciphertext: null,
    ...(welcomeTransport ?? {}),
  };

  io.to(conversationId).emit('new_message', newMessageEvent);
  io.to(conversationRoom(conversationId)).emit('new_message', newMessageEvent);

  const deliverySeconds = Number(process.hrtime.bigint() - deliveryStart) / 1e9;
  deliveryLatency.observe(deliverySeconds);
}
