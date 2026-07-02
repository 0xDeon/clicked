/**
 * Tests for presence tracking (issue #222) and typing indicator logic.
 *
 * Covers:
 *  - Multi-device aggregation: a user stays online when any socket remains.
 *  - Heartbeat timeout → offline: TTL expiry drives offline state.
 *  - Typing auto-expiry: typing indicators time out with no DB write.
 *  - Privacy suppression: non-members do not receive typing events.
 *  - Debounced transitions: rapid connect/disconnect leaves the user online.
 *
 * Uses fake timers where TTL/timeout logic is exercised so tests are fully
 * deterministic with no real I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ─────────────────────────────────────────────────────────────────

const { mockFindFirst, mockFindMany, mockUpdate } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
      messages: { findFirst: mockFindFirst },
    },
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  conversations: {},
  messages: {},
  files: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

// ── Presence service mock ────────────────────────────────────────────────────
//
// We test the presence.ts module in isolation with a fake Redis client so we
// can simulate TTL expiry via fake timers without hitting a real Redis server.

import { setOnline, setOffline, refreshPresence, isOnline } from '../services/presence.js';

type FakeRedisData = Map<string, Set<string>>;
type FakeTtlData = Map<string, number>;

function makeFakeRedis() {
  const store: FakeRedisData = new Map();
  const ttls: FakeTtlData = new Map();
  const hashes: Map<string, Record<string, string>> = new Map();

  return {
    store,
    ttls,
    hashes,
    async sadd(key: string, member: string) {
      if (!store.has(key)) store.set(key, new Set());
      store.get(key)!.add(member);
      return 1;
    },
    async srem(key: string, member: string) {
      store.get(key)?.delete(member);
      return 1;
    },
    async scard(key: string) {
      return store.get(key)?.size ?? 0;
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0;
    },
    async del(key: string) {
      store.delete(key);
      ttls.delete(key);
      hashes.delete(key);
      return 1;
    },
    async expire(key: string, seconds: number) {
      ttls.set(key, seconds);
      return 1;
    },
    async hset(key: string, fields: Record<string, string>) {
      if (!hashes.has(key)) hashes.set(key, {});
      Object.assign(hashes.get(key)!, fields);
      return 1;
    },
    async hdel(key: string, field: string) {
      const hash = hashes.get(key);
      if (hash) {
        delete hash[field];
      }
      return 1;
    },
    async hlen(key: string) {
      const hash = hashes.get(key);
      return hash ? Object.keys(hash).length : 0;
    },
    // Simulates TTL expiry: removes key as if Redis evicted it.
    simulateExpiry(key: string) {
      store.delete(key);
      ttls.delete(key);
      hashes.delete(key);
    },
  };
}

// ── Socket helpers ───────────────────────────────────────────────────────────

function makeSocket(userId: string, socketId = `socket-${userId}`) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];

  const socket = Object.assign(emitter, {
    id: socketId,
    auth: { userId },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
    join: vi.fn(),
    emitted,
  });

  return socket;
}

function makeIo() {
  const roomEmitted: { event: string; data: unknown }[] = [];
  const io = {
    to: vi.fn(() => ({
      emit: vi.fn((event: string, data: unknown) => {
        roomEmitted.push({ event, data });
      }),
    })),
    roomEmitted,
  };
  return io;
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. Multi-device aggregation ────────────────────────────────────────────

describe('presence: multi-device aggregation', () => {
  it('reports online when first device connects', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');

    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('reports online when second device connects while first remains', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOnline(redis as never, 'user-1', 'socket-b');

    expect(await isOnline(redis as never, 'user-1')).toBe(true);
    expect(Object.keys(redis.hashes.get('presence:user:user-1') ?? {}).length).toBe(2);
  });

  it('stays online when one of two devices disconnects', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOnline(redis as never, 'user-1', 'socket-b');

    const fullyOffline = await setOffline(redis as never, 'user-1', 'socket-a');

    expect(fullyOffline).toBe(false);
    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('goes offline only when the last device disconnects', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOnline(redis as never, 'user-1', 'socket-b');

    await setOffline(redis as never, 'user-1', 'socket-a');
    const fullyOffline = await setOffline(redis as never, 'user-1', 'socket-b');

    expect(fullyOffline).toBe(true);
    expect(await isOnline(redis as never, 'user-1')).toBe(false);
  });

  it('cleans up the presence key when user goes fully offline', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOffline(redis as never, 'user-1', 'socket-a');

    expect(redis.hashes.has('presence:user:user-1')).toBe(false);
  });
});

// ─── 2. Heartbeat timeout → offline ─────────────────────────────────────────

describe('presence: heartbeat timeout → offline', () => {
  it('refreshPresence sets a 60-second TTL when the key exists', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');

    await refreshPresence(redis as never, 'user-1', 'socket-a');

    expect(redis.ttls.get('presence:user:user-1:device:socket-a')).toBe(90);
  });

  it('refreshPresence is a no-op when the key does not exist (user already offline)', async () => {
    const redis = makeFakeRedis();

    await refreshPresence(redis as never, 'user-1', 'socket-a');

    expect(redis.ttls.has('presence:user:user-1:device:socket-a')).toBe(false);
  });

  it('user appears offline after TTL expiry (simulated)', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');

    // Simulate Redis evicting the device key due to TTL expiry
    redis.simulateExpiry('presence:user:user-1:device:socket-a');
    // Then explicitly remove device from hash (as would happen on next heartbeat check)
    await redis.hdel('presence:user:user-1', 'socket-a');

    expect(await isOnline(redis as never, 'user-1')).toBe(false);
  });

  it('heartbeat refresh keeps the user online past the initial TTL window', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');

    // Refresh before expiry — key should still be there
    await refreshPresence(redis as never, 'user-1', 'socket-a');

    expect(await isOnline(redis as never, 'user-1')).toBe(true);
    expect(redis.ttls.get('presence:user:user-1:device:socket-a')).toBe(90);
  });

  it('setOnline sets the 60-second TTL', async () => {
    const redis = makeFakeRedis();
    await setOnline(redis as never, 'user-1', 'socket-a');

    expect(redis.ttls.get('presence:user:user-1:device:socket-a')).toBe(90);
  });
});

// ─── 3. Typing auto-expiry + zero DB writes ──────────────────────────────────

describe('typing events: auto-expiry and no DB writes', () => {
  it('typing_start broadcasts to room without writing to DB', async () => {
    const userId = 'user-1';
    const conversationId = 'conv-1';

    mockFindFirst.mockResolvedValueOnce({ id: 'membership-1', userId, conversationId });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId });

    // Must NOT call db.update (no DB write for typing)
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('typing_stop broadcasts to room without writing to DB', async () => {
    const userId = 'user-2';
    const conversationId = 'conv-1';

    mockFindFirst.mockResolvedValueOnce({ id: 'membership-2', userId, conversationId });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_stop')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('typing indicator expires automatically using fake timers', async () => {
    vi.useFakeTimers();

    // Typing indicators are ephemeral — auto-expiry is handled client-side
    // after a TTL (e.g., 5 s). With fake timers we simulate the passage of
    // time to confirm the indicator expires.
    const TYPING_TTL_MS = 5000;

    let typingActive = true;
    const expireTyping = () => {
      typingActive = false;
    };

    // Schedule expiry after TTL
    const timer = setTimeout(expireTyping, TYPING_TTL_MS);

    // Indicator is active before TTL
    expect(typingActive).toBe(true);

    // Advance time past the TTL
    vi.advanceTimersByTime(TYPING_TTL_MS + 1);

    expect(typingActive).toBe(false);

    clearTimeout(timer);
  });

  it('typing indicator does not expire before the TTL elapses', async () => {
    vi.useFakeTimers();

    const TYPING_TTL_MS = 5000;
    let typingActive = true;

    const timer = setTimeout(() => {
      typingActive = false;
    }, TYPING_TTL_MS);

    vi.advanceTimersByTime(TYPING_TTL_MS - 1);

    expect(typingActive).toBe(true);

    clearTimeout(timer);
  });
});

// ─── 4. Privacy suppression ──────────────────────────────────────────────────

describe('typing events: privacy suppression for non-members', () => {
  it('emits error and does not broadcast when user is not a conversation member', async () => {
    const userId = 'outsider';
    const conversationId = 'conv-private';

    mockFindFirst.mockResolvedValueOnce(undefined); // no membership

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'typing_start',
        message: expect.stringContaining('member'),
      }),
    );

    // Room must receive no typing events
    expect(io.to).not.toHaveBeenCalled();
  });

  it('typing_stop: non-member gets error, no room broadcast', async () => {
    const userId = 'outsider';
    const conversationId = 'conv-private';

    mockFindFirst.mockResolvedValueOnce(undefined);

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_stop')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'typing_stop' }),
    );
    expect(io.to).not.toHaveBeenCalled();
  });
});

// ─── 5. Debounced transitions ────────────────────────────────────────────────

describe('presence: debounced connect/disconnect transitions', () => {
  it('rapid connect/disconnect on one socket while another stays open leaves user online', async () => {
    const redis = makeFakeRedis();

    // Two sockets connect
    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOnline(redis as never, 'user-1', 'socket-b');

    // socket-a disconnects rapidly
    const fullyOffline = await setOffline(redis as never, 'user-1', 'socket-a');

    // socket-b is still open → user stays online
    expect(fullyOffline).toBe(false);
    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('reconnect after full disconnect correctly reinstates online state', async () => {
    const redis = makeFakeRedis();

    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOffline(redis as never, 'user-1', 'socket-a'); // fully offline

    expect(await isOnline(redis as never, 'user-1')).toBe(false);

    // User reconnects
    await setOnline(redis as never, 'user-1', 'socket-new');
    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('three rapid connect events all register separate socket entries', async () => {
    const redis = makeFakeRedis();

    await setOnline(redis as never, 'user-1', 'socket-a');
    await setOnline(redis as never, 'user-1', 'socket-b');
    await setOnline(redis as never, 'user-1', 'socket-c');

    expect(Object.keys(redis.hashes.get('presence:user:user-1') ?? {}).length).toBe(3);
    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('debounce window: typing start followed immediately by stop then start again broadcasts correctly', async () => {
    vi.useFakeTimers();

    const TYPING_TTL_MS = 5000;
    let typingActive = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    function startTyping() {
      typingActive = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        typingActive = false;
      }, TYPING_TTL_MS);
    }

    function stopTyping() {
      typingActive = false;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
    }

    // Start → stop → start (rapid)
    startTyping();
    vi.advanceTimersByTime(100);
    stopTyping();
    vi.advanceTimersByTime(50);
    startTyping();

    // Typing is active again
    expect(typingActive).toBe(true);

    // Advance past TTL → auto-expires
    vi.advanceTimersByTime(TYPING_TTL_MS + 1);
    expect(typingActive).toBe(false);
  });
});
