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

export function recordViolation(socketId: string): number {
  const count = (violationCount.get(socketId) ?? 0) + 1;
  violationCount.set(socketId, count);
  return count;
}

export function clearViolations(socketId: string): void {
  violationCount.delete(socketId);
}
