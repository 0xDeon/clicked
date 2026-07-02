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
