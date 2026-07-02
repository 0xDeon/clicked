import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  conversations: {},
  messages: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn(),
}));

vi.mock('../lib/messages.js', () => ({
  serializeMessage: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  redis: null,
}));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock Socket helpers ────────────────────────────────────────────────────

function makeSocket(userId: string, rooms: string[] = []) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];
  const roomEmitted: { room: string; event: string; data: unknown }[] = [];

  const socket = Object.assign(emitter, {
    id: `sock-${userId}`,
    auth: { userId },
    rooms: new Set(rooms),
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, data: unknown) => {
        roomEmitted.push({ room, event, data });
      }),
    })),
    join: vi.fn((room: string) => {
      socket.rooms.add(room);
    }),
    emitted,
    roomEmitted,
  });

  return socket;
}

function makeIo() {
  const roomEmitted: { room: string; event: string; data: unknown }[] = [];
  const io = {
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, data: unknown) => {
        roomEmitted.push({ room, event, data });
      }),
    })),
    roomEmitted,
  };
  return io;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Typing indicator Socket events (typing_start / typing_stop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('relays typing_start to conversation room members with zero DB writes', async () => {
    const userId = 'user-123';
    const conversationId = 'conv-abc';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId });

    // Zero DB writes
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();

    // Relayed to room via socket.to(room).emit
    expect(socket.to).toHaveBeenCalledWith(conversationId);
    expect(socket.roomEmitted).toContainEqual({
      room: conversationId,
      event: 'typing_start',
      data: { conversationId, userId },
    });
  });

  it('includes optional deviceId but never relays content', async () => {
    const userId = 'user-123';
    const conversationId = 'conv-abc';
    const deviceId = 'device-xyz';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId,
      deviceId,
      content: 'SUPER SECRET CONFIDENTIAL TEXT',
      extraField: 12345,
    });

    expect(socket.roomEmitted).toContainEqual({
      room: conversationId,
      event: 'typing_start',
      data: { conversationId, userId, deviceId },
    });

    const emittedPayload = socket.roomEmitted[0]!.data as Record<string, unknown>;
    expect(emittedPayload).not.toHaveProperty('content');
    expect(emittedPayload).not.toHaveProperty('extraField');
  });

  it('auto-clears typing state after timeout (5 seconds) if no typing_stop', async () => {
    const userId = 'user-timer';
    const conversationId = 'conv-timer';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const startHandler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await startHandler({ conversationId });

    expect(socket.roomEmitted).toHaveLength(1);
    expect(socket.roomEmitted[0]?.event).toBe('typing_start');

    // Advance time by 4.9 seconds - should not clear yet
    vi.advanceTimersByTime(4900);
    expect(socket.roomEmitted).toHaveLength(1);

    // Advance time past 5 seconds
    vi.advanceTimersByTime(100);
    expect(socket.roomEmitted).toHaveLength(2);
    expect(socket.roomEmitted[1]).toEqual({
      room: conversationId,
      event: 'typing_stop',
      data: { conversationId, userId },
    });
  });

  it('manual typing_stop clears auto-expire timeout and relays typing_stop', async () => {
    const userId = 'user-stop';
    const conversationId = 'conv-stop';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const startHandler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    const stopHandler = (socket as EventEmitter).listeners('typing_stop')[0] as (
      p: unknown,
    ) => Promise<void>;

    await startHandler({ conversationId });
    await stopHandler({ conversationId });

    expect(socket.roomEmitted).toHaveLength(2);
    expect(socket.roomEmitted[1]?.event).toBe('typing_stop');

    // Advance time by 10 seconds - timer should have been cancelled, no duplicate typing_stop
    vi.advanceTimersByTime(10000);
    expect(socket.roomEmitted).toHaveLength(2);
  });

  it('guards non-members when socket not in room and DB membership check fails', async () => {
    const userId = 'outsider';
    const conversationId = 'conv-private';
    const socket = makeSocket(userId, []); // not in room
    const io = makeIo();

    mockFindFirst.mockResolvedValueOnce(undefined); // DB check says not a member

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const startHandler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await startHandler({ conversationId });

    expect(socket.to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'typing_start',
        message: expect.stringContaining('member'),
      }),
    );
  });

  it('clears active typing state on disconnect', async () => {
    const userId = 'user-dc';
    const conversationId = 'conv-dc';
    const deviceId = 'dev-dc';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const startHandler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    await startHandler({ conversationId, deviceId });

    expect(socket.roomEmitted).toHaveLength(1);

    // Trigger disconnect
    const dcHandlers = (socket as EventEmitter).listeners('disconnect');
    for (const h of dcHandlers) {
      h();
    }

    expect(socket.roomEmitted).toHaveLength(2);
    expect(socket.roomEmitted[1]).toEqual({
      room: conversationId,
      event: 'typing_stop',
      data: { conversationId, userId, deviceId },
    });
  });

  it('clears active typing state on send_message', async () => {
    const userId = 'user-msg';
    const conversationId = 'conv-msg';
    const socket = makeSocket(userId, [conversationId]);
    const io = makeIo();

    mockFindFirst.mockResolvedValue({ id: 'mem-1', userId, conversationId });
    mockFindMany.mockResolvedValue([]);
    const returnFn = vi.fn().mockResolvedValue([{ id: 'msg-1', content: 'hello' }]);
    const valFn = vi.fn().mockReturnValue({ returning: returnFn });
    mockInsert.mockReturnValue({ values: valFn });

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const startHandler = (socket as EventEmitter).listeners('typing_start')[0] as (
      p: unknown,
    ) => Promise<void>;
    const sendHandler = (socket as EventEmitter).listeners('send_message')[0] as (
      p: unknown,
    ) => Promise<void>;

    await startHandler({ conversationId });
    expect(socket.roomEmitted).toHaveLength(1);

    await sendHandler({ conversationId, content: 'Done typing!' });

    // Should emit new_message (io.to) AND typing_stop (socket.to)
    expect(socket.roomEmitted).toContainEqual({
      room: conversationId,
      event: 'typing_stop',
      data: { conversationId, userId },
    });
  });
});
