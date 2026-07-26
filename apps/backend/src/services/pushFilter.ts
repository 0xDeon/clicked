/**
 * Shared push recipient filtering for consistent behavior across all push paths.
 *
 * Implements unified filtering logic for:
 * - dispatchOfflinePush (text messages)
 * - sendPushForMessage (file messages)
 *
 * Ensures both paths respect:
 * - conversationMembers.isMuted
 * - devices.pushEnabled
 * - device connection state
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, devices } from '../db/schema.js';
import { isDeviceConnected } from './deviceRevocation.js';
import type { Redis } from 'ioredis';
import { isOnline } from './presence.js';

export interface PushRecipient {
  deviceId: string;
  userId: string;
}

export interface PushFilterOptions {
  conversationId: string;
  senderId: string;
  recipientDeviceIds?: string[]; // If provided, filter from this list; else discover from members
  redis?: Redis | null;
}

/**
 * Get all eligible push recipients for a conversation message.
 *
 * Filters out:
 * - The sender themselves
 * - Members who muted the conversation
 * - Users currently online (active WebSocket)
 * - Devices with pushEnabled=false
 * - Revoked devices
 * - Devices that are currently connected via WebSocket
 *
 * @returns Array of device IDs that should receive push notifications
 */
export async function getEligiblePushRecipients(options: PushFilterOptions): Promise<string[]> {
  const { conversationId, senderId, recipientDeviceIds, redis } = options;

  // Step 1: Get conversation members with mute status
  const allMembers = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true, isMuted: true },
  });

  // Filter out sender and muted members
  const eligibleMembers = allMembers.filter(
    (member) => member.userId !== senderId && !member.isMuted,
  );

  if (eligibleMembers.length === 0) {
    return [];
  }

  const eligibleUserIds = eligibleMembers.map((m) => m.userId);

  // Step 2: Filter out online users (if Redis is available)
  const offlineUserIds: string[] = [];
  if (redis) {
    for (const userId of eligibleUserIds) {
      const online = await isOnline(redis, userId);
      if (!online) {
        offlineUserIds.push(userId);
      }
    }
  } else {
    // No Redis — assume all users are offline (best-effort push)
    offlineUserIds.push(...eligibleUserIds);
  }

  if (offlineUserIds.length === 0) {
    return [];
  }

  // Step 3: Get active, push-enabled devices for offline users
  const memberDevices = await db.query.devices.findMany({
    where: and(
      eq(devices.pushEnabled, true),
      isNull(devices.revokedAt),
      // Filter by offline user IDs
      ...offlineUserIds.map((uid) => eq(devices.userId, uid)),
    ),
    columns: { id: true, userId: true },
  });

  let candidateDevices = memberDevices;

  // Step 4: If specific recipient device IDs were provided, intersect with them
  if (recipientDeviceIds) {
    if (recipientDeviceIds.length === 0) {
      return []; // Explicit empty list means no recipients
    }
    const recipientSet = new Set(recipientDeviceIds);
    candidateDevices = memberDevices.filter((d) => recipientSet.has(d.id));
  }

  // Step 5: Filter out connected devices (realtime WebSocket connection exists)
  const offlineDeviceIds: string[] = [];
  for (const device of candidateDevices) {
    if (!isDeviceConnected(device.id)) {
      offlineDeviceIds.push(device.id);
    }
  }

  return offlineDeviceIds;
}
