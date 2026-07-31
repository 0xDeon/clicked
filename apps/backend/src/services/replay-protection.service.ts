import type { Redis } from 'ioredis';

/**
 * Replay Protection Service
 *
 * Prevents replay attacks using Redis SET with NX flag. Each event is tracked
 * by a unique key combining deviceId and eventId. The first occurrence of an
 * event succeeds (returns false — not a replay), and subsequent duplicates
 * within the TTL window are dropped (returns true — is a replay).
 *
 * Fail-open behavior: if Redis is unavailable, the event is processed anyway
 * to avoid blocking legitimate traffic.
 */

function getReplayProtectionTtl(): number {
  const val = process.env['REPLAY_PROTECTION_TTL_SECONDS'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 86400) {
      return parsed;
    }
  }
  return 300; // Default: 5 minutes
}

function getRedisKey(deviceId: string, eventId: string): string {
  return `replay:${deviceId}:${eventId}`;
}

/**
 * Check if an event is a replay and atomically mark it as seen.
 *
 * Uses Redis SET with NX (only set if not exists) and EX (expires after TTL).
 * - If SET NX succeeds: key was new, return false (NOT a replay — process it)
 * - If SET NX fails: key already exists, return true (IS a replay — drop it)
 * - If Redis is unavailable: return false (fail open — process the event)
 *
 * @param redis Redis client instance (or null if unavailable)
 * @param deviceId Device ID
 * @param eventId Event ID
 * @returns true if this is a replay, false if this is the first occurrence
 */
export async function isReplay(
  redis: Redis | null,
  deviceId: string,
  eventId: string,
): Promise<boolean> {
  // Gracefully handle missing Redis
  if (!redis) {
    return false;
  }

  // Skip check if deviceId or eventId is missing or empty
  if (!deviceId?.trim() || !eventId?.trim()) {
    return false;
  }

  const key = getRedisKey(deviceId, eventId);
  const ttl = getReplayProtectionTtl();

  try {
    // SET NX EX: set key to '1' only if it doesn't exist, with TTL
    // Returns 'OK' if set was successful (new key), null if key already exists
    const result = await redis.set(key, '1', 'EX', ttl, 'NX');
    return result === null; // null means key existed (is a replay)
  } catch (err) {
    // Redis error — fail open and log a warning
    console.warn('[replay-protection] Redis error during SET:', err instanceof Error ? err.message : String(err));
    return false; // Allow the event through
  }
}

/**
 * Get the Redis key for a replay protection entry.
 * Primarily used for testing and debugging.
 *
 * @param deviceId Device ID
 * @param eventId Event ID
 * @returns The Redis key
 */
export function getReplayProtectionRedisKey(deviceId: string, eventId: string): string {
  return getRedisKey(deviceId, eventId);
}

/**
 * Explicitly mark an event as seen (mainly for testing).
 * Not normally needed since isReplay() marks atomically.
 *
 * @param redis Redis client instance
 * @param deviceId Device ID
 * @param eventId Event ID
 */
export async function markSeen(
  redis: Redis | null,
  deviceId: string,
  eventId: string,
): Promise<void> {
  if (!redis || !deviceId?.trim() || !eventId?.trim()) {
    return;
  }

  const key = getRedisKey(deviceId, eventId);
  const ttl = getReplayProtectionTtl();

  try {
    await redis.setex(key, ttl, '1');
  } catch (err) {
    console.warn('[replay-protection] Redis error during SETEX:', err instanceof Error ? err.message : String(err));
  }
}
