import type { Redis } from 'ioredis';
import { getSocketServer } from '../lib/socket.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { setOffline, getDeviceSocketIds, isDeviceConnectedInRegistry } from './presence.js';

// Revocation flags are checked on the hot path (every incoming socket event,
// via index.ts's socket.use middleware), so they stay in-process rather than
// round-tripping to Redis. Socket↔device tracking, by contrast, moved to the
// Redis-backed registry in presence.ts (#341) so it's visible cross-node —
// the old in-process Maps here only ever saw sockets on the local gateway.
const revokedMidSession = new Set<string>();

export function isDeviceRevoked(deviceId: string): boolean {
  return revokedMidSession.has(deviceId);
}

/**
 * Cross-node connected check backed by the shared Redis registry (#341).
 * Callers that only have a deviceId (no userId) — e.g. push notification's
 * online check — resolve correctly even when the device's live socket is
 * connected to a different gateway instance.
 */
export async function isDeviceConnected(redis: Redis | null, deviceId: string): Promise<boolean> {
  if (!redis) return false;
  return isDeviceConnectedInRegistry(redis, deviceId);
}

export function markDeviceRevoked(deviceId: string): void {
  revokedMidSession.add(deviceId);
}

export async function startDeviceRevocationListener(
  redis: Redis,
  appRedis: Redis | null,
): Promise<void> {
  if (redis.status !== 'ready' && redis.status !== 'connect') {
    await redis.connect();
  }

  await redis.psubscribe('device_revoked:*');

  redis.on('pmessage', async (_pattern: string, channel: string, _message: string) => {
    const deviceId = channel.replace('device_revoked:', '');
    markDeviceRevoked(deviceId);

    console.log(`Device revoked mid-session: ${deviceId}`);

    if (!appRedis) return;

    const socketIds = await getDeviceSocketIds(appRedis, deviceId);
    const io = getSocketServer();

    for (const socketId of socketIds) {
      // Only sockets local to this gateway instance are found here — every
      // node runs this same listener (it's driven by Redis pub/sub), so the
      // node actually holding the connection is the one that disconnects it.
      const socket = io?.sockets.sockets.get(socketId) as AuthSocket | undefined;
      if (socket) {
        if (socket.auth) {
          await setOffline(appRedis, socket.auth.userId, socket.auth.deviceId);
        }
        socket.emit('device_revoked', { message: 'This device has been revoked' });
        socket.disconnect(true);
      }
    }
  });
}
