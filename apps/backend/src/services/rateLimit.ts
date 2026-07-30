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
