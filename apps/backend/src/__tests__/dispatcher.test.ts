import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { EventDispatcher } from '../socket/dispatcher.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import type { Server } from 'socket.io';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(
  auth: { userId: string; deviceId: string } | null = { userId: 'u1', deviceId: 'd1' },
) {
  const emitter = new EventEmitter();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const rawEmit = emitter.emit.bind(emitter);

  const socket = Object.assign(emitter, {
    auth: auth ?? undefined,
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
      return true;
    }),
    to: vi.fn(),
    join: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as AuthSocket;

  // trigger: simulate a client event arriving at the server socket.
  // Must go through the real EventEmitter (not the mocked emit) so
  // socket.on() listeners fire.
  const trigger = (event: string, data: unknown) => rawEmit(event, data);

  return { socket, emitted, trigger };
}

function makeIo() {
  return { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as Server;
}

function makeRedis(setResult: string | null = 'OK') {
  return {
    set: vi.fn().mockResolvedValue(setResult),
    publish: vi.fn().mockResolvedValue(1),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventDispatcher.register — no raw socket.on fallback (#342)', () => {
  it('does NOT call the handler when the raw, non-enveloped event name is emitted directly', async () => {
    const { socket, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    const handler = vi.fn().mockResolvedValue(undefined);

    dispatcher.register('join_room', handler);
    dispatcher.listen();
    trigger('join_room', { conversationId: 'c1' });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('only invokes the handler through the enveloped dispatch path', async () => {
    const { socket, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn().mockResolvedValue(undefined);

    dispatcher.register('join_room', handler);
    dispatcher.listen();

    // Raw emit is silently ignored — no listener attached for the bare type.
    trigger('join_room', { conversationId: 'c1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();

    // Enveloped emit through 'dispatch' reaches the handler.
    trigger('dispatch', {
      eventId: 'evt-raw-vs-enveloped',
      type: 'join_room',
      timestamp: Date.now(),
      payload: { conversationId: 'c1' },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith({ conversationId: 'c1' });
  });

  it('handler errors from the enveloped path do not propagate (never crash)', async () => {
    const { socket, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'evt-error',
      type: 'join_room',
      timestamp: Date.now(),
      payload: { conversationId: 'c1' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalled();
  });
});

describe('EventDispatcher.listen — envelope routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a valid envelope to the registered handler', async () => {
    const { socket, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn().mockResolvedValue(undefined);

    dispatcher.register('send_message', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'evt-1',
      type: 'send_message',
      timestamp: Date.now(),
      payload: { conversationId: 'c1', messageId: 'm1' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith({ conversationId: 'c1', messageId: 'm1' });
  });

  it('emits error and skips handler on malformed envelope', async () => {
    const { socket, emitted, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    const handler = vi.fn();
    dispatcher.register('send_message', handler);
    dispatcher.listen();

    trigger('dispatch', { eventId: '', type: 'send_message', timestamp: 1 });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('emits error for unknown event type without crashing', async () => {
    const { socket, emitted, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'evt-2',
      type: 'totally_unknown_type',
      timestamp: Date.now(),
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('skips duplicate eventId (idempotency) when Redis says already processed', async () => {
    const { socket, trigger } = makeSocket();
    const redis = makeRedis(null); // null = SET NX returned null = key exists
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn();
    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'dup-evt',
      type: 'join_room',
      timestamp: Date.now(),
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('processes event and sends ack when eventId is new', async () => {
    const { socket, emitted, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'new-evt',
      type: 'join_room',
      timestamp: Date.now(),
      payload: { conversationId: 'c1' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalled();
    const ack = emitted.find((e) => e.event === 'dispatch_ack');
    expect(ack).toBeDefined();
    expect((ack?.data as { duplicate: boolean }).duplicate).toBe(false);
  });

  it('rejects stale envelopes before dispatching the handler', async () => {
    const { socket, emitted, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn();
    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'stale-evt',
      type: 'join_room',
      timestamp: Date.now() - 301_000,
      payload: { conversationId: 'c1' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      event: 'error',
      data: expect.objectContaining({
        payload: expect.objectContaining({
          eventId: 'stale-evt',
          message: 'Stale or invalid envelope timestamp',
        }),
      }),
    });
  });

  it('rejects envelopes too far in the future', async () => {
    const { socket, emitted, trigger } = makeSocket();
    const redis = makeRedis('OK');
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn();
    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'future-evt',
      type: 'join_room',
      timestamp: Date.now() + 31_000,
      payload: { conversationId: 'c1' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      event: 'error',
      data: expect.objectContaining({
        payload: expect.objectContaining({
          eventId: 'future-evt',
          message: 'Stale or invalid envelope timestamp',
        }),
      }),
    });
  });

  it('rejects unauthenticated socket', async () => {
    const { socket, emitted, trigger } = makeSocket(null);
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    dispatcher.listen();

    trigger('dispatch', {
      eventId: 'evt-unauth',
      type: 'join_room',
      timestamp: Date.now(),
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('EventDispatcher — configurable replay-protection TTL (#344)', () => {
  // Dedup is delegated to services/replay-protection.service.ts, which keys on
  // (deviceId, eventId) rather than eventId alone — two devices legitimately
  // generating the same eventId must not block each other — and reads its
  // window from REPLAY_PROTECTION_TTL_SECONDS.
  const ORIGINAL_TTL = process.env['REPLAY_PROTECTION_TTL_SECONDS'];

  afterEach(() => {
    if (ORIGINAL_TTL === undefined) delete process.env['REPLAY_PROTECTION_TTL_SECONDS'];
    else process.env['REPLAY_PROTECTION_TTL_SECONDS'] = ORIGINAL_TTL;
  });

  async function dispatchOnce(redis: ReturnType<typeof makeRedis>, eventId: string) {
    const { socket, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, redis as never);
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('join_room', handler);
    dispatcher.listen();

    trigger('dispatch', { eventId, type: 'join_room', timestamp: Date.now(), payload: {} });
    await new Promise((r) => setTimeout(r, 10));
    return handler;
  }

  it('defaults the TTL to 300 seconds when unset', async () => {
    delete process.env['REPLAY_PROTECTION_TTL_SECONDS'];
    const redis = makeRedis('OK');

    await dispatchOnce(redis, 'evt-default-ttl');

    expect(redis.set).toHaveBeenCalledWith('replay:d1:evt-default-ttl', '1', 'EX', 300, 'NX');
  });

  it('reads the TTL from REPLAY_PROTECTION_TTL_SECONDS when configured', async () => {
    process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '120';
    const redis = makeRedis('OK');

    await dispatchOnce(redis, 'evt-custom-ttl');

    expect(redis.set).toHaveBeenCalledWith('replay:d1:evt-custom-ttl', '1', 'EX', 120, 'NX');
  });

  it('falls back to the default TTL for an invalid (non-numeric) override', async () => {
    process.env['REPLAY_PROTECTION_TTL_SECONDS'] = 'not-a-number';
    const redis = makeRedis('OK');

    await dispatchOnce(redis, 'evt-invalid-ttl');

    expect(redis.set).toHaveBeenCalledWith('replay:d1:evt-invalid-ttl', '1', 'EX', 300, 'NX');
  });

  it('keys the dedup entry on the device, so one device cannot block another', async () => {
    const redis = makeRedis('OK');

    await dispatchOnce(redis, 'shared-event-id');

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('replay:d1:'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('rejects a duplicate eventId within the TTL window', async () => {
    process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '300';
    // null == SET NX found the key already present (still within the window)
    const redis = makeRedis(null);

    const handler = await dispatchOnce(redis, 'evt-duplicate-within-ttl');

    expect(handler).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      'replay:d1:evt-duplicate-within-ttl',
      '1',
      'EX',
      300,
      'NX',
    );
  });
});
