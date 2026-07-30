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

function getMaxEnvelopeSize(): number {
  const val = process.env['MAX_ENVELOPE_SIZE'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 4096;
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
