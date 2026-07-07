import { and, eq, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { messageEnvelopes, userDevices, conversationMembers, messages } from '../db/schema.js';
import { publishEphemeral } from './resumeStream.js';
import type { Redis } from 'ioredis';
import { conversationRoom } from './roomManager.js';

/**
 * Check if a message has been delivered to all active devices for a recipient user.
 * Returns true if every active device (not revoked) has a deliveredAt timestamp.
 */
export async function isMessageFullyDeliveredToUser(
  messageId: string,
  recipientUserId: string,
): Promise<boolean> {
  // Get all active devices for this user
  const activeDevices = await db
    .select({ id: userDevices.id })
    .from(userDevices)
    .where(and(eq(userDevices.userId, recipientUserId), isNull(userDevices.revokedAt)));

  if (activeDevices.length === 0) {
    // No active devices, consider message delivered by default
    return true;
  }

  const activeDeviceIds = activeDevices.map((d) => d.id);

  // Check all envelopes for these devices
  const envelopes = await db
    .select({
      recipientDeviceId: messageEnvelopes.recipientDeviceId,
      deliveredAt: messageEnvelopes.deliveredAt,
    })
    .from(messageEnvelopes)
    .where(
      and(
        eq(messageEnvelopes.messageId, messageId),
        eq(messageEnvelopes.recipientUserId, recipientUserId),
      ),
    );

  const deliveredDeviceIds = new Set(
    envelopes.filter((e) => e.deliveredAt !== null).map((e) => e.recipientDeviceId),
  );

  // Check if every active device has received the message
  return activeDeviceIds.every((deviceId) => deliveredDeviceIds.has(deviceId));
}

/**
 * Handle per-device delivery receipt and notify sender when all active devices have received.
 * This function is idempotent - duplicate calls won't create incorrect state.
 */
export async function handleDeviceDeliveryReceipt(
  io: Server,
  redis: Redis | null,
  messageId: string,
  recipientDeviceId: string,
  recipientUserId: string,
  conversationId: string,
): Promise<void> {
  // First, get the message to find the sender
  const message = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { senderId: true, conversationId: true },
  });

  if (!message) {
    console.warn(`[deliveryAggregation] Message not found: ${messageId}`);
    return;
  }

  // Duplicate receipt for a device already marked delivered — nothing to do.
  const existingEnvelope = await db.query.messageEnvelopes.findFirst({
    where: and(
      eq(messageEnvelopes.messageId, messageId),
      eq(messageEnvelopes.recipientDeviceId, recipientDeviceId),
    ),
    columns: { deliveredAt: true },
  });

  if (existingEnvelope?.deliveredAt) {
    return;
  }

  // Update deliveredAt for this specific device (idempotent)
  await db
    .update(messageEnvelopes)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(messageEnvelopes.messageId, messageId),
        eq(messageEnvelopes.recipientDeviceId, recipientDeviceId),
      ),
    );

  // Check if this user now has all devices delivered
  const fullyDelivered = await isMessageFullyDeliveredToUser(messageId, recipientUserId);

  if (fullyDelivered) {
    // Notify sender that this recipient has fully received the message
    io.to(`room:user:${message.senderId}`).emit('message_fully_delivered', {
      messageId,
      conversationId,
      recipientUserId,
      deliveredAt: new Date().toISOString(),
    });

    // Also notify via Redis for cross-instance delivery
    if (redis) {
      await publishEphemeral(redis, [message.senderId], {
        type: 'message_fully_delivered',
        data: {
          messageId,
          conversationId,
          recipientUserId,
        },
      });
    }
  }

  // Emit per-device delivery receipt for other conversation members
  io.to(conversationRoom(conversationId)).volatile.emit('device_delivery_receipt', {
    conversationId,
    messageId,
    recipientUserId,
    recipientDeviceId,
    deliveredAt: new Date().toISOString(),
  });

  if (redis) {
    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await publishEphemeral(
      redis,
      members.map((member) => member.userId),
      {
        type: 'device_delivery_receipt',
        data: {
          conversationId,
          messageId,
          recipientUserId,
          recipientDeviceId,
        },
      },
    );
  }
}

/**
 * Get delivery status for a message across all recipients.
 * Returns a map of recipientUserId -> {fullyDelivered: boolean, deviceDeliveries: Array}
 */
export async function getMessageDeliveryStatus(
  messageId: string,
  conversationId: string,
): Promise<
  Record<
    string,
    {
      fullyDelivered: boolean;
      deviceDeliveries: Array<{ deviceId: string; deliveredAt: string | null }>;
    }
  >
> {
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  const result: Record<
    string,
    {
      fullyDelivered: boolean;
      deviceDeliveries: Array<{ deviceId: string; deliveredAt: string | null }>;
    }
  > = {};

  for (const member of members) {
    // Get all envelopes for this user
    const envelopes = await db
      .select({
        recipientDeviceId: messageEnvelopes.recipientDeviceId,
        deliveredAt: messageEnvelopes.deliveredAt,
      })
      .from(messageEnvelopes)
      .where(
        and(
          eq(messageEnvelopes.messageId, messageId),
          eq(messageEnvelopes.recipientUserId, member.userId),
        ),
      );

    const fullyDelivered = await isMessageFullyDeliveredToUser(messageId, member.userId);

    result[member.userId] = {
      fullyDelivered,
      deviceDeliveries: envelopes.map((e) => ({
        deviceId: e.recipientDeviceId,
        deliveredAt: e.deliveredAt?.toISOString() ?? null,
      })),
    };
  }

  return result;
}
