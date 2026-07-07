import type { Server } from 'socket.io';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers } from '../db/schema.js';

/**
 * Room name constants following the pattern: room:{type}:{id}
 */
export function conversationRoom(conversationId: string): string {
  return `room:conversation:${conversationId}`;
}

export function userRoom(userId: string): string {
  return `room:user:${userId}`;
}

/**
 * Join conversation room for optimized fan-out.
 * Rooms are performance optimizations only - never authoritative for permissions.
 */
export async function joinConversationRoom(
  socket: AuthSocket,
  conversationId: string,
): Promise<void> {
  const userId = socket.auth!.userId;

  // Always validate membership from source of truth before joining
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    throw new Error('Not a member of this conversation');
  }

  await socket.join(conversationRoom(conversationId));
}

/**
 * Join user room for cross-device synchronization.
 */
export function joinUserRoom(socket: AuthSocket): void {
  const userId = socket.auth!.userId;
  socket.join(userRoom(userId));
}

/**
 * Rebuild rooms after gateway restart.
 * This should be called during startup to ensure all active sockets
 * are in the appropriate rooms based on PostgreSQL data.
 */
export async function rebuildRoomsAfterRestart(io: Server): Promise<void> {
  console.log('[roomManager] Rebuilding rooms after restart');

  const sockets = await io.fetchSockets();

  for (const socket of sockets) {
    const authSocket = socket as AuthSocket;
    const userId = authSocket.auth?.userId;
    const deviceId = authSocket.auth?.deviceId;

    if (!userId || !deviceId) {
      continue;
    }

    // Join user room for cross-device events
    await authSocket.join(userRoom(userId));

    // Join all conversation rooms user belongs to
    const memberships = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.userId, userId),
      columns: { conversationId: true },
    });

    for (const membership of memberships) {
      await authSocket.join(conversationRoom(membership.conversationId));
    }
  }

  console.log(`[roomManager] Rebuilt rooms for ${sockets.length} sockets`);
}

/**
 * Emit typing indicator to conversation room.
 * Uses conversation rooms for optimized fan-out.
 */
export function emitTypingIndicator(
  io: Server,
  conversationId: string,
  userId: string,
  deviceId: string,
): void {
  io.to(conversationRoom(conversationId)).emit('typing_start', {
    conversationId,
    userId,
    deviceId,
  });
}

/**
 * Emit typing stop to conversation room.
 */
export function emitTypingStop(
  io: Server,
  conversationId: string,
  userId: string,
  deviceId: string,
): void {
  io.to(conversationRoom(conversationId)).emit('typing_stop', {
    conversationId,
    userId,
    deviceId,
  });
}

/**
 * Emit presence update to conversation room.
 */
export function emitPresenceUpdate(
  io: Server,
  conversationId: string,
  userId: string,
  online: boolean,
  lastSeen?: number,
): void {
  io.to(conversationRoom(conversationId)).emit('presence_update', {
    userId,
    online,
    status: online ? 'online' : 'offline',
    ...(lastSeen ? { lastSeen } : {}),
  });
}

/**
 * Emit cross-device account event to user room.
 */
export function emitCrossDeviceEvent(
  io: Server,
  userId: string,
  eventType: string,
  data: Record<string, unknown>,
): void {
  io.to(userRoom(userId)).emit('cross_device_event', {
    type: eventType,
    userId,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Validate conversation membership before allowing room-based operations.
 * This ensures rooms are only an optimization, not an authorization mechanism.
 */
export async function validateConversationMembership(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  return membership !== null;
}
