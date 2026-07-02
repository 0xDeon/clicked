import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { db } from '../db/index.js';
import { devices, userDevices } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { refreshPresence, markDeviceOffline, refreshPresenceSocket, unregisterPresenceSocket } from './presence.js';

const HEARTBEAT_TIMEOUT_MS = 90_000;
const LAST_SEEN_THROTTLE_MS = 30_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSeenAt = new Map<string, number>();

export function startHeartbeatTimer(
  socket: AuthSocket,
  userId: string,
  deviceId: string,
  redis: Redis | null,
  io: Server,
  identityPublicKey?: string,
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

  socket.on('heartbeat', async () => {
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
        await db.update(devices).set({ updatedAt: new Date() }).where(eq(devices.id, deviceId));
      } catch {
        // Non-critical update; ignore errors.
      }

      // Update user_devices.lastSeenAt for device-based presence derivation.
      if (identityPublicKey) {
        try {
          await db
            .update(userDevices)
            .set({ lastSeenAt: new Date() })
            .where(
              and(
                eq(userDevices.userId, userId),
                eq(userDevices.identityPublicKey, identityPublicKey),
                isNull(userDevices.revokedAt),
              ),
            );
        } catch {
          // Non-critical update; ignore errors.
        }
      }
    }

    schedule();
  });
}

export function clearHeartbeatTimer(socketId: string): void {
  clearTimeout(timers.get(socketId));
  timers.delete(socketId);
}
