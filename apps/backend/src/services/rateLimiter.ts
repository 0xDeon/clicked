/**
 * Redis-backed rate-limit counters (#375).
 *
 * Counters live in Redis so a limit holds across every gateway node — an
 * in-process counter is worthless the moment the deployment scales past one
 * pod, because an attacker just gets N times the budget by reconnecting.
 *
 * Window strategy: fixed windows, keyed by `floor(now / windowSeconds)`. A
 * sliding log would be more precise at the boundary, but a fixed window is one
 * `INCRBY` and one `EXPIRE` per check with no per-request set membership, and
 * the worst case (2x the limit across a window boundary) is acceptable for
 * abuse control. The window index is part of the key, so expiry is
 * self-correcting and no sweeper is needed.
 *
 * Degradation: if Redis is unavailable or errors, the check falls back to a
 * per-process counter rather than failing open entirely. A cross-node limit
 * degrades to a per-node limit — still bounded — instead of taking the whole
 * API down with Redis, which matches how the rest of this codebase treats a
 * Redis outage.
 */
import { redis } from '../lib/redis.js';
import {
  getRateLimitRule,
  isRateLimitingDisabled,
  type RateLimitBucket,
} from '../config/rateLimits.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Configured ceiling for the window. */
  limit: number;
  /** Remaining budget, floored at 0. */
  remaining: number;
  /** Seconds until the current window rolls over. */
  resetSeconds: number;
  /** Consumption so far in this window, including the current request. */
  used: number;
}

/** Fallback counters used only while Redis is unreachable. */
const localCounters = new Map<string, { used: number; expiresAt: number }>();

function windowIndex(windowSeconds: number, now: number): number {
  return Math.floor(now / 1000 / windowSeconds);
}

function counterKey(bucket: string, identifier: string, window: number): string {
  return `rl:${bucket}:${window}:${identifier}`;
}

function consumeLocally(key: string, cost: number, ttlSeconds: number, now: number): number {
  const existing = localCounters.get(key);

  if (!existing || existing.expiresAt <= now) {
    // Opportunistic prune — the map only ever holds live windows this way, so
    // a Redis outage cannot grow it without bound.
    for (const [candidate, entry] of localCounters) {
      if (entry.expiresAt <= now) localCounters.delete(candidate);
    }
    localCounters.set(key, { used: cost, expiresAt: now + ttlSeconds * 1000 });
    return cost;
  }

  existing.used += cost;
  return existing.used;
}

/**
 * Charge `cost` against a bucket for `identifier` and report whether the
 * request may proceed. `cost` is what makes this usable for volume quotas
 * (bytes uploaded) as well as request counts.
 */
export async function consumeRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
  cost = 1,
): Promise<RateLimitResult> {
  const rule = getRateLimitRule(bucket);

  if (isRateLimitingDisabled()) {
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetSeconds: rule.windowSeconds,
      used: 0,
    };
  }

  const now = Date.now();
  const window = windowIndex(rule.windowSeconds, now);
  const key = counterKey(bucket, identifier, window);
  const resetSeconds = Math.max(1, Math.ceil((window + 1) * rule.windowSeconds - now / 1000));

  let used: number;

  if (redis) {
    try {
      const results = await redis
        .multi()
        .incrby(key, cost)
        // Re-arming the TTL on every hit is harmless: the window index is part
        // of the key, so a stale window can never be charged again.
        .expire(key, rule.windowSeconds)
        .exec();

      const incremented = results?.[0]?.[1];
      if (typeof incremented !== 'number') {
        throw new Error('unexpected INCRBY reply');
      }
      used = incremented;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[rateLimit] Redis unavailable (${message}) — using per-node counters`);
      used = consumeLocally(key, cost, rule.windowSeconds, now);
    }
  } else {
    used = consumeLocally(key, cost, rule.windowSeconds, now);
  }

  return {
    allowed: used <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - used),
    resetSeconds,
    used,
  };
}

/**
 * Read a bucket without charging it. Used where a request must be checked
 * against a quota before the cost is known to be acceptable.
 */
export async function peekRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): Promise<RateLimitResult> {
  return consumeRateLimit(bucket, identifier, 0);
}

/** Drop a counter. Exposed for tests and for operator-initiated unblocking. */
export async function resetRateLimit(bucket: RateLimitBucket, identifier: string): Promise<void> {
  const rule = getRateLimitRule(bucket);
  const key = counterKey(bucket, identifier, windowIndex(rule.windowSeconds, Date.now()));

  localCounters.delete(key);

  if (redis) {
    await redis.del(key).catch(() => {});
  }
}

/**
 * Drop every counter in a bucket, across all windows and subjects. Used by the
 * test suite and by operators unblocking a bucket after a bad limit change.
 * Scans rather than `KEYS` so it does not stall a busy Redis.
 */
export async function resetRateLimitBucket(bucket: RateLimitBucket): Promise<void> {
  const prefix = `rl:${bucket}:`;

  for (const key of localCounters.keys()) {
    if (key.startsWith(prefix)) localCounters.delete(key);
  }

  if (!redis) return;

  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch {
    // Best-effort: a counter that survives simply expires with its window.
  }
}

/** Clear every in-process counter. Test-only helper. */
export function clearLocalRateLimitCounters(): void {
  localCounters.clear();
}
