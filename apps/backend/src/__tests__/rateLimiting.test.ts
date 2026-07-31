/**
 * #375 — centralised limits, Redis-backed counters, and coverage across the
 * sensitive HTTP endpoints and socket events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';

// A single shared Redis stands in for the cluster every gateway node talks to.
const sharedRedis = new RedisMock();

vi.mock('../lib/redis.js', () => ({
  redis: sharedRedis,
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn(), findMany: vi.fn() },
      devices: { findFirst: vi.fn(), findMany: vi.fn() },
      devicePrekeys: { findFirst: vi.fn(), findMany: vi.fn() },
      conversationMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      files: { findFirst: vi.fn() },
      messages: { findFirst: vi.fn() },
    },
    execute: vi.fn().mockResolvedValue([]),
  },
}));

const { consumeRateLimit, resetRateLimitBucket, clearLocalRateLimitCounters, peekRateLimit } =
  await import('../services/rateLimiter.js');
const { rateLimit, ipIdentifier } = await import('../middleware/rateLimit.js');
const { getRateLimitRule, socketEventBucket, RATE_LIMIT_DEFAULTS } =
  await import('../config/rateLimits.js');
const { checkSocketEventRateLimit } = await import('../services/rateLimit.js');
const { usersRouter } = await import('../routes/users.js');
const { uploadsRouter } = await import('../routes/uploads.js');
const { filesRouter } = await import('../routes/files.js');
const { pushRouter } = await import('../routes/push.js');
const { authRouter } = await import('../routes/auth.js');

const ENV_KEYS = [
  'RATE_LIMIT_KEY_BUNDLE',
  'RATE_LIMIT_SOCKET_DEFAULT',
  'RATE_LIMIT_UPLOAD_SLOT',
  'RATE_LIMIT_DISABLED',
  'SOCKET_RATE_LIMIT_PER_SEC',
] as const;

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  clearLocalRateLimitCounters();
  await sharedRedis.flushall();
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ─── configuration ────────────────────────────────────────────────────────────

describe('rate-limit configuration', () => {
  it('AC3 — every bucket is overridable per environment', () => {
    expect(getRateLimitRule('key_bundle')).toMatchObject(RATE_LIMIT_DEFAULTS.key_bundle);

    process.env['RATE_LIMIT_KEY_BUNDLE'] = '60/120';
    expect(getRateLimitRule('key_bundle')).toMatchObject({ limit: 60, windowSeconds: 120 });

    // Limit alone keeps the default window.
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '7';
    expect(getRateLimitRule('key_bundle')).toMatchObject({
      limit: 7,
      windowSeconds: RATE_LIMIT_DEFAULTS.key_bundle.windowSeconds,
    });

    // A malformed override must not silently disable the limit.
    process.env['RATE_LIMIT_KEY_BUNDLE'] = 'lots';
    expect(getRateLimitRule('key_bundle')).toMatchObject(RATE_LIMIT_DEFAULTS.key_bundle);
  });

  it('still honours the historical SOCKET_RATE_LIMIT_PER_SEC knob', () => {
    process.env['SOCKET_RATE_LIMIT_PER_SEC'] = '3';
    expect(getRateLimitRule('socket_default')).toMatchObject({ limit: 3, windowSeconds: 1 });

    // An explicit bucket override wins over the legacy variable.
    process.env['RATE_LIMIT_SOCKET_DEFAULT'] = '25/5';
    expect(getRateLimitRule('socket_default')).toMatchObject({ limit: 25, windowSeconds: 5 });
  });

  it('routes each socket event to its bucket, with a default for the rest', () => {
    expect(socketEventBucket('send_message')).toBe('socket_send_message');
    expect(socketEventBucket('send_file_message')).toBe('socket_send_message');
    expect(socketEventBucket('typing_start')).toBe('socket_typing');
    expect(socketEventBucket('ask_assistant')).toBe('socket_ask_assistant');
    expect(socketEventBucket('join_room')).toBe('socket_default');
  });
});

// ─── counters ─────────────────────────────────────────────────────────────────

describe('rate-limit counters', () => {
  it('allows up to the limit and blocks past it', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '3/60';

    for (let i = 0; i < 3; i++) {
      const result = await consumeRateLimit('key_bundle', 'user:alice');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2 - i);
    }

    const blocked = await consumeRateLimit('key_bundle', 'user:alice');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });

  it('keeps subjects and buckets independent', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '1/60';

    expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(true);
    expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(false);

    // A different subject has its own budget…
    expect((await consumeRateLimit('key_bundle', 'user:bob')).allowed).toBe(true);
    // …and so does a different bucket for the same subject.
    expect((await consumeRateLimit('upload_slot', 'user:alice')).allowed).toBe(true);
  });

  it('AC2 — counters are shared across nodes, not held per process', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '3/60';

    await consumeRateLimit('key_bundle', 'user:alice');
    await consumeRateLimit('key_bundle', 'user:alice');

    // Simulate the request landing on a second gateway node: same Redis, no
    // shared process memory. The budget must carry over.
    clearLocalRateLimitCounters();

    const third = await consumeRateLimit('key_bundle', 'user:alice');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await consumeRateLimit('key_bundle', 'user:alice');
    expect(fourth.allowed).toBe(false);

    // The counter really is in Redis, reachable by any node.
    const keys = await sharedRedis.keys('rl:key_bundle:*');
    expect(keys).toHaveLength(1);
  });

  it('charges volume quotas by cost, not by request count', async () => {
    process.env['RATE_LIMIT_UPLOAD_SLOT'] = '100/60';

    const first = await consumeRateLimit('upload_slot', 'user:alice', 60);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(40);

    const second = await consumeRateLimit('upload_slot', 'user:alice', 60);
    expect(second.allowed).toBe(false);
  });

  it('peeks without charging', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '2/60';

    await consumeRateLimit('key_bundle', 'user:alice');
    const peeked = await peekRateLimit('key_bundle', 'user:alice');
    expect(peeked.remaining).toBe(1);

    const stillAllowed = await consumeRateLimit('key_bundle', 'user:alice');
    expect(stillAllowed.allowed).toBe(true);
  });

  it('falls back to per-node counters when Redis errors instead of failing open', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '2/60';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const multi = vi.spyOn(sharedRedis, 'multi').mockImplementation(() => {
      throw new Error('connection refused');
    });

    try {
      expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(true);
      expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(true);
      // Still bounded — the limit degrades from cluster-wide to node-local.
      expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(false);
    } finally {
      multi.mockRestore();
      warn.mockRestore();
    }
  });

  it('resets a whole bucket across every window and subject', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '1/60';

    await consumeRateLimit('key_bundle', 'user:alice');
    expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(false);

    await resetRateLimitBucket('key_bundle');

    expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(true);
  });

  it('can be switched off entirely for load tests', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '1/60';
    process.env['RATE_LIMIT_DISABLED'] = 'true';

    for (let i = 0; i < 5; i++) {
      expect((await consumeRateLimit('key_bundle', 'user:alice')).allowed).toBe(true);
    }
  });
});

// ─── middleware ───────────────────────────────────────────────────────────────

describe('rate-limit middleware', () => {
  function buildApp() {
    const app = express();
    app.get('/limited', rateLimit('key_bundle', { identifier: ipIdentifier }), (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('answers 429 with Retry-After and the standard budget headers', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '2/60';
    const app = buildApp();

    const first = await request(app).get('/limited');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');

    await request(app).get('/limited');

    const blocked = await request(app).get('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('Too many requests');
    expect(blocked.body.bucket).toBe('key_bundle');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
  });

  it('reports the tightest remaining budget when several buckets guard a route', async () => {
    process.env['RATE_LIMIT_KEY_BUNDLE'] = '10/60';
    const app = express();
    app.get(
      '/limited',
      rateLimit(['key_bundle', 'key_bundle_daily'], { identifier: ipIdentifier }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );

    const res = await request(app).get('/limited');

    expect(res.status).toBe(200);
    // key_bundle (10) is tighter than key_bundle_daily, so it is the one reported.
    expect(res.headers['ratelimit-limit']).toBe('10');
    expect(res.headers['ratelimit-remaining']).toBe('9');
  });
});

// ─── coverage across sensitive surfaces ───────────────────────────────────────

type Layer = { name?: string; route?: { path: unknown; stack: Array<{ name?: string }> } };

/** Names of the handlers guarding a route, so wiring can be asserted directly. */
function routeHandlers(router: { stack: Layer[] }, path: string): string[] {
  return router.stack
    .filter((layer) => {
      const routePath = layer.route?.path;
      return Array.isArray(routePath) ? routePath.includes(path) : routePath === path;
    })
    .flatMap((layer) => layer.route?.stack.map((handler) => handler.name ?? '') ?? []);
}

describe('AC1 — limits are applied across the sensitive surfaces', () => {
  it.each([
    ['key-bundle fetch', usersRouter, '/:userId/devices/:deviceId/key-bundle'],
    ['upload slot', uploadsRouter, '/'],
    ['file download', filesRouter, '/:fileId'],
    ['push subscribe', pushRouter, '/subscriptions'],
    ['auth challenge', authRouter, '/challenge'],
    ['auth verify', authRouter, '/verify'],
  ])('%s is rate limited', (_label, router, path) => {
    expect(routeHandlers(router as unknown as { stack: Layer[] }, path)).toContain(
      'rateLimitHandler',
    );
  });

  it('charges socket events to the device, so a reconnect does not reset the budget', async () => {
    process.env['RATE_LIMIT_SOCKET_DEFAULT'] = '2/60';

    expect((await checkSocketEventRateLimit('join_room', 'device-1')).allowed).toBe(true);
    expect((await checkSocketEventRateLimit('join_room', 'device-1')).allowed).toBe(true);
    expect((await checkSocketEventRateLimit('join_room', 'device-1')).allowed).toBe(false);

    // A different device is unaffected.
    expect((await checkSocketEventRateLimit('join_room', 'device-2')).allowed).toBe(true);
  });

  it('gives send_message its own budget, separate from the default event bucket', async () => {
    process.env['RATE_LIMIT_SOCKET_DEFAULT'] = '1/60';

    expect((await checkSocketEventRateLimit('join_room', 'device-1')).allowed).toBe(true);
    expect((await checkSocketEventRateLimit('join_room', 'device-1')).allowed).toBe(false);

    // send_message is charged elsewhere and still has its full allowance.
    expect((await checkSocketEventRateLimit('send_message', 'device-1')).allowed).toBe(true);
  });
});
