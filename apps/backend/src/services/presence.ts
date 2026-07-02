/**
 * Online presence tracking.
 *
 * Stores a Redis hash for each user with deviceId → lastSeen values. Each
 * device also has a small per-device key with its own TTL so heartbeat timeouts
 * can remove that device entry without forcing the whole user offline.
 *
 * - On connect:   add socketId to `presence:{userId}` set, set TTL 60s
 * - On heartbeat: refresh TTL to 60s
 * - On disconnect: remove socketId from set, if set empty → user_offline
 * - GET /users/:id/presence → { online: boolean, lastSeen?: string }
 *
 * User presence is derived from device presence: a user is online when any
 * non-expired device entry exists (Redis OR user_devices.lastSeenAt within
 * the window). When offline, lastSeen reflects the most recent device activity.
 * - On connect: upsert device entry in `presence:user:{userId}` and refresh TTL
 * - On heartbeat: update lastSeen and refresh the device TTL
 * - On disconnect/timeout: remove that device entry; if none remain → user offline
 * Socket IDs are tracked in Redis separately from device presence. Those
 * mappings let a freshly booted gateway rebuild Socket.IO room membership for
 * sockets that are still active on other gateway instances, without creating
 * duplicate device-level presence entries.
 *
 * - On connect: upsert device entry, track socket mapping, refresh TTLs
 * - On heartbeat: update lastSeen and refresh device/socket TTLs
 * - On disconnect/timeout: remove socket mapping; remove device only when no
 *   live sockets remain for that device
 * - GET /users/:id/presence → { online: boolean }
 */
import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { isNull, eq, and, gte, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userDevices, conversationMembers } from '../db/schema.js';

const PRESENCE_TTL = 90; // seconds
const SOCKET_MAPPING_PREFIX = 'presence:sockets:';

type RedisWithOptionalHashRead = Redis & {
  hgetall?: (key: string) => Promise<Record<string, string>>;
};

function presenceHashKey(userId: string): string {
  return `presence:user:${userId}`;
}

function presenceDeviceKey(userId: string, deviceId: string): string {
  return `presence:user:${userId}:device:${deviceId}`;
}

function presenceSocketsKey(userId: string): string {
  return `${SOCKET_MAPPING_PREFIX}${userId}`;
}

function presenceDeviceSocketsKey(userId: string, deviceId: string): string {
  return `presence:device_sockets:${userId}:${deviceId}`;
}

function presenceSocketKey(socketId: string): string {
  return `presence:socket:${socketId}`;
}

/**
 * Register a device connection for a user. Adds or updates the device entry and
 * sets/refreshes the per-device TTL.
 */
export async function setOnline(
  redis: Redis,
  userId: string,
  deviceId: string,
  lastSeen = String(Date.now()),
): Promise<boolean> {
  const hashKey = presenceHashKey(userId);
  const deviceKey = presenceDeviceKey(userId, deviceId);
  const wasOnline = (await redis.hlen(hashKey)) > 0;

  await redis.hset(hashKey, { [deviceId]: lastSeen });
  await redis.hset(deviceKey, { lastSeen });
  await redis.expire(deviceKey, PRESENCE_TTL);

  return !wasOnline;
}

/**
 * Track the Socket.IO socket that currently represents a user/device session.
 * This is intentionally separate from device-level presence so reconnecting the
 * same device does not create duplicate presence entries.
 */
export async function registerPresenceSocket(
  redis: Redis,
  userId: string,
  deviceId: string,
  socketId: string,
): Promise<void> {
  const userSocketsKey = presenceSocketsKey(userId);
  const deviceSocketsKey = presenceDeviceSocketsKey(userId, deviceId);
  const socketKey = presenceSocketKey(socketId);

  await redis.sadd(userSocketsKey, socketId);
  await redis.sadd(deviceSocketsKey, socketId);
  await redis.hset(socketKey, { userId, deviceId });
  await redis.expire(userSocketsKey, PRESENCE_TTL);
  await redis.expire(deviceSocketsKey, PRESENCE_TTL);
  await redis.expire(socketKey, PRESENCE_TTL);
}

/** Refresh only the socket-mapping TTLs for an already-connected socket. */
export async function refreshPresenceSocket(
  redis: Redis,
  userId: string,
  deviceId: string,
  socketId: string,
): Promise<void> {
  await registerPresenceSocket(redis, userId, deviceId, socketId);
}

export async function setOnline(redis: Redis, userId: string, socketId: string): Promise<boolean> {
  const key = presenceKey(userId);
  const debounceKey = `presence_debounce:${userId}`;

  const count = await redis.scard(key);
  await redis.sadd(key, socketId);
  await redis.expire(key, PRESENCE_TTL);

  if (count === 0) {
    const debouncing = await redis.del(debounceKey);
    if (debouncing === 1) {
      return false; // Flap detected, don't broadcast online
    }
    return true; // First socket connected
  }
  return false;
/**
 * Remove a socket mapping. Returns true when that device has no remaining
 * tracked sockets, so callers may safely remove the device-level presence entry.
 */
export async function unregisterPresenceSocket(
  redis: Redis,
  userId: string,
  deviceId: string,
  socketId: string,
): Promise<boolean> {
  const userSocketsKey = presenceSocketsKey(userId);
  const deviceSocketsKey = presenceDeviceSocketsKey(userId, deviceId);

  await redis.srem(userSocketsKey, socketId);
  await redis.srem(deviceSocketsKey, socketId);
  await redis.del(presenceSocketKey(socketId));

  const remainingDeviceSockets = await redis.scard(deviceSocketsKey);
  if (remainingDeviceSockets === 0) {
    await redis.del(deviceSocketsKey);
  }

  const remainingUserSockets = await redis.scard(userSocketsKey);
  if (remainingUserSockets === 0) {
    await redis.del(userSocketsKey);
  }

  return remainingDeviceSockets === 0;
}

/**
 * Refresh the presence timestamp and TTL for a specific device (called on heartbeat).
 */
export async function refreshPresence(
  redis: Redis,
  userId: string,
  deviceId: string,
  lastSeen = String(Date.now()),
): Promise<void> {
  const hashKey = presenceHashKey(userId);
  const deviceKey = presenceDeviceKey(userId, deviceId);

  const exists = (await redis.hlen(hashKey)) > 0;
  if (!exists) {
    return;
  }

  await redis.hset(hashKey, { [deviceId]: lastSeen });
  await redis.hset(deviceKey, { lastSeen });
  await redis.expire(deviceKey, PRESENCE_TTL);
}

/**
 * Remove a device connection from the user's presence hash.
 * Returns true if the user has gone fully offline (no remaining devices).
 */
export async function setOffline(redis: Redis, userId: string, deviceId: string): Promise<boolean> {
  const hashKey = presenceHashKey(userId);
  const deviceKey = presenceDeviceKey(userId, deviceId);

  await redis.hdel(hashKey, deviceId);
  await redis.del(deviceKey);

  const remaining = await redis.hlen(hashKey);
  if (remaining === 0) {
    await redis.del(hashKey);
    return true;
  }
  return false;
}

/**
 * Forcefully mark a device offline and remove it from the per-user hash.
 * Used when a heartbeat timeout or device revocation occurs.
 */
export async function markDeviceOffline(
  redis: Redis,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const hashKey = presenceHashKey(userId);
  const deviceKey = presenceDeviceKey(userId, deviceId);

  await redis.hdel(hashKey, deviceId);
  await redis.del(deviceKey);

  const remaining = await redis.hlen(hashKey);
  if (remaining === 0) {
    await redis.del(hashKey);
    return true;
  }
  return false;
}

/**
 * Check if a user is currently online.
 */
export async function isOnline(redis: Redis, userId: string): Promise<boolean> {
  const key = presenceHashKey(userId);
  const count = await redis.hlen(key);
  return count > 0;
}

const DEVICE_PRESENCE_WINDOW_MS = 90_000;

/**
 * Derive user presence from device presence: a user is considered online
 * if any non-revoked device has a lastSeenAt within the presence window.
 * When offline, returns the most recent lastSeenAt across all devices.
 */
export async function deriveDevicePresence(
  userId: string,
): Promise<{ online: boolean; lastSeen: string | null }> {
  const windowStart = new Date(Date.now() - DEVICE_PRESENCE_WINDOW_MS);

  const activeDevice = await db.query.userDevices.findFirst({
    where: and(
      eq(userDevices.userId, userId),
      isNull(userDevices.revokedAt),
      gte(userDevices.lastSeenAt, windowStart),
    ),
    columns: { id: true },
  });

  if (activeDevice) {
    return { online: true, lastSeen: null };
  }

  const mostRecent = await db.query.userDevices.findFirst({
    where: and(eq(userDevices.userId, userId), isNull(userDevices.revokedAt)),
    orderBy: desc(userDevices.lastSeenAt),
    columns: { lastSeenAt: true },
  });

  return {
    online: false,
    lastSeen: mostRecent?.lastSeenAt?.toISOString() ?? null,
  };
}

async function removeStaleSocketMapping(
  redis: Redis,
  userId: string,
  socketId: string,
): Promise<void> {
  const redisWithHashRead = redis as RedisWithOptionalHashRead;
  const mapping = redisWithHashRead.hgetall
    ? await redisWithHashRead.hgetall(presenceSocketKey(socketId))
    : {};
  const deviceId = mapping['deviceId'];

  await redis.srem(presenceSocketsKey(userId), socketId);
  if (deviceId) {
    const deviceSocketsKey = presenceDeviceSocketsKey(userId, deviceId);
    await redis.srem(deviceSocketsKey, socketId);
    const remainingDeviceSockets = await redis.scard(deviceSocketsKey);
    if (remainingDeviceSockets === 0) {
      await redis.del(deviceSocketsKey);
    }
  }
  await redis.del(presenceSocketKey(socketId));
}

/**
 * Remove any socket IDs in the user's Redis socket mapping that are no longer
 * connected anywhere in the Socket.IO cluster.
 */
export async function cleanupStaleSockets(
  io: Server,
  redis: Redis,
  userId: string,
  ignoredSocketId?: string,
): Promise<void> {
  const key = presenceSocketsKey(userId);
  const socketIds = await redis.smembers(key);
  if (socketIds.length === 0) return;

  await Promise.all(
    socketIds.map(async (sid) => {
      if (ignoredSocketId && sid === ignoredSocketId) return;
      try {
        const sockets = await io.in(sid).fetchSockets();
        if (sockets.length === 0) {
          await removeStaleSocketMapping(redis, userId, sid);
        }
      } catch (err) {
        console.warn(`[presence] Failed to check socket status for ${sid}:`, err);
      }
    }),
  );

  const remaining = await redis.scard(key);
  if (remaining === 0) {
    await redis.del(key);
  }
}

/**
 * Rebuild room subscriptions from active Redis socket mappings on gateway boot.
 */
export async function reconcileBoot(io: Server, redis: Redis): Promise<void> {
  let presenceSocketKeys: string[];
  try {
    let cursor = '0';
    presenceSocketKeys = [];
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${SOCKET_MAPPING_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      presenceSocketKeys.push(...keys);
    } while (cursor !== '0');
  } catch {
    presenceSocketKeys = await redis.keys(`${SOCKET_MAPPING_PREFIX}*`);
  }

  for (const key of presenceSocketKeys) {
    const userId = key.slice(SOCKET_MAPPING_PREFIX.length);
    if (!userId) continue;

    const socketIds = await redis.smembers(key);
    if (socketIds.length === 0) {
      await redis.del(key);
      continue;
    }

    try {
      const memberships = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.userId, userId),
        columns: { conversationId: true },
      });

      await Promise.all(
        socketIds.map(async (socketId) => {
          const sockets = await io.in(socketId).fetchSockets();
          if (sockets.length === 0) {
            await removeStaleSocketMapping(redis, userId, socketId);
            return;
          }

          for (const m of memberships) {
            io.in(socketId).socketsJoin(m.conversationId);
          }
        }),
      );

      const remaining = await redis.scard(key);
      if (remaining === 0) {
        await redis.del(key);
      }
    } catch (err) {
      console.warn(`[presence] Failed to rebuild subscriptions for ${userId}:`, err);
    }
  }
}
