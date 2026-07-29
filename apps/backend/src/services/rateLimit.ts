import type { Redis } from 'ioredis';

function getRateLimitPerSec(): number {
  const val = process.env['SOCKET_RATE_LIMIT_PER_SEC'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 10;
}

function getMaxPayloadSize(): number {
  const val = process.env['MAX_PAYLOAD_SIZE'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 16384;
}

const violationCount = new Map<string, number>();

export async function checkRateLimit(
  redis: Redis | null,
  socketId: string,
): Promise<{ allowed: boolean; count: number }> {
  const limit = getRateLimitPerSec();
  if (!redis) return { allowed: true, count: 0 };

  const key = `rl:socket:${socketId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 1);
  }
  return { allowed: count <= limit, count };
}

export function checkPayloadSize(data: unknown): { valid: boolean; size: number } {
  const maxSize = getMaxPayloadSize();
  const raw = JSON.stringify(data);
  const size = Buffer.byteLength(raw, 'utf8');
  return { valid: size <= maxSize, size };
}

export function recordViolation(socketId: string): number {
  const count = (violationCount.get(socketId) ?? 0) + 1;
  violationCount.set(socketId, count);
  return count;
}

export function clearViolations(socketId: string): void {
  violationCount.delete(socketId);
}

// ─── Abuse / spam controls (#378) ─────────────────────────────────────────────
//
// Two counters per user, both stored in Redis with sliding 1-hour windows:
//
//   abuse:first_contact:{userId}  — how many new DMs the user initiated
//   abuse:group_invite:{userId}   — how many group members the user added
//
// Default caps are intentionally conservative and overridable via env vars.

const FIRST_CONTACT_LIMIT = parseInt(process.env['FIRST_CONTACT_HOUR_LIMIT'] ?? '5', 10);
const GROUP_INVITE_LIMIT = parseInt(process.env['GROUP_INVITE_HOUR_LIMIT'] ?? '10', 10);
const ABUSE_WINDOW_SECONDS = 3600; // 1 hour

/**
 * Checks whether `userId` is allowed to initiate a new first-contact DM.
 * Callers must gate DM creation on `allowed === true`.
 */
export async function checkFirstContactLimit(
  redis: Redis | null,
  userId: string,
): Promise<{ allowed: boolean; count: number }> {
  if (!redis) return { allowed: true, count: 0 };
  const key = `abuse:first_contact:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ABUSE_WINDOW_SECONDS);
  return { allowed: count <= FIRST_CONTACT_LIMIT, count };
}

/**
 * Checks whether `userId` is allowed to add another member to a group.
 * Callers must gate the member-add on `allowed === true`.
 */
export async function checkGroupInviteLimit(
  redis: Redis | null,
  userId: string,
): Promise<{ allowed: boolean; count: number }> {
  if (!redis) return { allowed: true, count: 0 };
  const key = `abuse:group_invite:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ABUSE_WINDOW_SECONDS);
  return { allowed: count <= GROUP_INVITE_LIMIT, count };
}
