import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import {
  refreshPresence,
  markDeviceOffline,
  refreshPresenceSocket,
  unregisterPresenceSocket,
} from './presence.js';

const HEARTBEAT_TIMEOUT_MS = 90_000;
const LAST_SEEN_THROTTLE_MS = 30_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSeenAt = new Map<string, number>();
const schedules = new Map<string, () => void>();

export function startHeartbeatTimer(
  socket: AuthSocket,
  userId: string,
  deviceId: string,
  redis: Redis | null,
  io: Server,
): void {
  const schedule = () => {
    clearTimeout(timers.get(socket.id));
    const timer = setTimeout(async () => {
      timers.delete(socket.id);
      console.log(`Heartbeat timeout for device ${deviceId} (user ${userId})`);

      let fullyOffline = true;
      if (redis) {
        const deviceHasNoSockets = await unregisterPresenceSocket(
          redis,
          userId,
          deviceId,
          socket.id,
        );
        fullyOffline = deviceHasNoSockets
          ? await markDeviceOffline(redis, userId, deviceId)
          : false;
      }

      if (socket.connected && fullyOffline) {
        for (const room of socket.rooms) {
          if (room !== socket.id) {
            io.to(room).volatile.emit('user_offline', { userId });
            io.to(room).volatile.emit('presence_update', { userId, online: false });
          }
        }
      }

      if (socket.connected) {
        socket.disconnect(true);
      }
    }, HEARTBEAT_TIMEOUT_MS);
    timers.set(socket.id, timer);
  };

  schedule();
  schedules.set(socket.id, schedule);
}

/**
 * Handles a heartbeat received through the standard envelope dispatcher
 * (#342 — heartbeat used to be a raw socket.on listener entirely outside
 * the dispatcher). Resets the disconnect-timeout timer, refreshes presence,
 * and throttles the lastSeenAt DB write.
 */
export async function handleHeartbeat(
  socket: AuthSocket,
  userId: string,
  deviceId: string,
  redis: Redis | null,
): Promise<void> {
  clearTimeout(timers.get(socket.id));
  timers.delete(socket.id);

  if (redis) {
    await refreshPresence(redis, userId, deviceId);
    await refreshPresenceSocket(redis, userId, deviceId, socket.id);
  }

  const now = Date.now();
  const last = lastSeenAt.get(deviceId) ?? 0;
  if (now - last >= LAST_SEEN_THROTTLE_MS) {
    lastSeenAt.set(deviceId, now);
    try {
      await db
        .update(devices)
        .set({ lastSeenAt: new Date(), updatedAt: new Date() })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
    } catch {
      // Non-critical update; ignore errors.
    }
  }

  schedules.get(socket.id)?.();
}

export function clearHeartbeatTimer(socketId: string): void {
  clearTimeout(timers.get(socketId));
  timers.delete(socketId);
  schedules.delete(socketId);
}
