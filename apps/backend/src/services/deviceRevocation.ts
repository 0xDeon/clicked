import type { Redis } from 'ioredis';
import { getSocketServer } from '../lib/socket.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { setOffline } from './presence.js';

const deviceSockets = new Map<string, Set<string>>();
const socketDevice = new Map<string, string>();
const revokedMidSession = new Set<string>();

export function registerDeviceSocket(deviceId: string, socketId: string): void {
  let sockets = deviceSockets.get(deviceId);
  if (!sockets) {
    sockets = new Set();
    deviceSockets.set(deviceId, sockets);
  }
  sockets.add(socketId);
  socketDevice.set(socketId, deviceId);
}

export function unregisterDeviceSocket(socketId: string): void {
  const deviceId = socketDevice.get(socketId);
  if (deviceId) {
    const sockets = deviceSockets.get(deviceId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        deviceSockets.delete(deviceId);
      }
    }
    socketDevice.delete(socketId);
  }
}

export function isDeviceRevoked(deviceId: string): boolean {
  return revokedMidSession.has(deviceId);
}

export function isDeviceConnected(deviceId: string): boolean {
  const sockets = deviceSockets.get(deviceId);
  return sockets !== undefined && sockets.size > 0;
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

    const socketIds = deviceSockets.get(deviceId);
    if (socketIds) {
      const io = getSocketServer();
      for (const socketId of [...socketIds]) {
        if (io) {
          const socket = io.sockets.sockets.get(socketId) as AuthSocket | undefined;
          if (socket) {
            if (appRedis && socket.auth) {
              await setOffline(appRedis, socket.auth.userId, socket.auth.deviceId);
            }
            socket.emit('device_revoked', { message: 'This device has been revoked' });
            socket.disconnect(true);
          }
        }
        unregisterDeviceSocket(socketId);
      }
    }
  });
}
