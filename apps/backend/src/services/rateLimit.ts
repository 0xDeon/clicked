/**
 * Socket-level abuse controls: payload size, per-event rate limits and
 * repeat-violation tracking.
 *
 * Rate limiting itself lives in `services/rateLimiter.ts` and its budget in
 * `config/rateLimits.ts` (#375). This module only decides *what* to charge for
 * a given socket event.
 */
import { socketEventBucket } from '../config/rateLimits.js';
import { consumeRateLimit, type RateLimitResult } from '../services/rateLimiter.js';

function getMaxPayloadSize(): number {
  const val = process.env['MAX_PAYLOAD_SIZE'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 16384;
}

function getMaxEnvelopeSize(): number {
  const val = process.env['MAX_ENVELOPE_SIZE'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 4096;
}

const violationCount = new Map<string, number>();

/**
 * Charge a socket event against its bucket.
 *
 * The subject is the device, not the socket id: a socket id is minted fresh on
 * every reconnect, so a client that gets throttled could previously reset its
 * budget just by cycling the connection. The device id survives reconnects and
 * is bound to the verified token, so it cannot be spoofed from a payload.
 */
export async function checkSocketEventRateLimit(
  event: string,
  deviceId: string,
): Promise<RateLimitResult> {
  return consumeRateLimit(socketEventBucket(event), `device:${deviceId}`);
}

export function checkPayloadSize(data: unknown): { valid: boolean; size: number } {
  const maxSize = getMaxPayloadSize();
  const raw = JSON.stringify(data);
  const size = Buffer.byteLength(raw, 'utf8');
  return { valid: size <= maxSize, size };
}

/**
 * Validates each envelope's ciphertext length individually, in addition to
 * the total-payload cap enforced by checkPayloadSize. A fan-out to many
 * recipient devices can stay under the aggregate cap while packing an
 * oversized ciphertext into a single envelope, so each one needs its own
 * check (#343).
 */
export function checkEnvelopeSizes(
  envelopes: Array<{ recipientDeviceId: string; ciphertext: string }> | undefined,
): { valid: boolean; oversizedDeviceId?: string; size?: number } {
  if (!envelopes || envelopes.length === 0) return { valid: true };

  const maxSize = getMaxEnvelopeSize();
  for (const envelope of envelopes) {
    const size = Buffer.byteLength(envelope.ciphertext ?? '', 'utf8');
    if (size > maxSize) {
      return { valid: false, oversizedDeviceId: envelope.recipientDeviceId, size };
    }
  }
  return { valid: true };
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
