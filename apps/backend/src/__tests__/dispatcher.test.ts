import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('EventDispatcher.register + backward-compat socket.on', () => {
  it('calls handler when raw event is emitted', async () => {
    const { socket, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    const handler = vi.fn().mockResolvedValue(undefined);

    dispatcher.register('join_room', handler);
    trigger('join_room', { conversationId: 'c1' });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith({ conversationId: 'c1' });
  });

  it('handler errors do not propagate (never crash)', async () => {
    const { socket, trigger } = makeSocket();
    const dispatcher = new EventDispatcher(makeIo(), socket, null);
    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    dispatcher.register('join_room', handler);
    trigger('join_room', { conversationId: 'c1' });

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
