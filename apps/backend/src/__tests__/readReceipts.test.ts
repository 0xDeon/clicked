import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();

const mockFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindFirst, findMany: mockFindMany },
      messages: { findFirst: mockFindFirst },
    },
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  conversations: {},
  messages: {},
}));

// Keep these unit tests isolated from the CI Redis service so the
// if (redis) branch in message_read never runs here.
vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  sql: vi.fn(),
}));

// ── Mock Socket helpers ────────────────────────────────────────────────────

function makeSocket(userId: string) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];

  const socket = Object.assign(emitter, {
    auth: { userId },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    join: vi.fn(),
    emitted,
  });

  return socket;
}

function makeIo() {
  const roomEmitted: { event: string; data: unknown }[] = [];
  const emitFn = vi.fn((event: string, data: unknown) => {
    roomEmitted.push({ event, data });
  });
  const io = {
    to: vi.fn(() => ({
      emit: emitFn,
      volatile: { emit: emitFn },
    })),
    roomEmitted,
  };
  return io;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('message_read socket event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it('persists last_read_message_id and broadcasts read_receipt', async () => {
    const userId = 'user-abc';
    const conversationId = 'conv-1';
    const lastReadMessageId = 'msg-99';

    // findFirst called twice: membership check, then message check
    mockFindFirst
      .mockResolvedValueOnce({ id: 'membership-1', userId, conversationId }) // membership
      .mockResolvedValueOnce({ id: lastReadMessageId, conversationId }); // message

    const setFn = vi.fn().mockReturnThis();
    const whereFn = vi.fn().mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: whereFn });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId, lastReadMessageId });

    expect(mockUpdate).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({ lastReadMessageId });
    expect(io.to).toHaveBeenCalledWith(conversationId);
  });

  it('emits error when caller is not a conversation member', async () => {
    const socket = makeSocket('outsider');
    const io = makeIo();

    mockFindFirst.mockResolvedValueOnce(undefined); // no membership

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId: 'conv-x', lastReadMessageId: 'msg-1' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'message_read',
        message: expect.stringContaining('member'),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('emits error when message does not belong to the conversation', async () => {
    const userId = 'user-abc';
    mockFindFirst
      .mockResolvedValueOnce({ id: 'm1', userId, conversationId: 'conv-1' }) // membership ok
      .mockResolvedValueOnce(undefined); // message not found

    const setFn = vi.fn().mockReturnThis();
    mockUpdate.mockReturnValue({ set: setFn });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId: 'conv-1', lastReadMessageId: 'wrong-msg' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'message_read',
        message: expect.stringContaining('Message not found'),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('DB update is called with correct lastReadMessageId', async () => {
    const userId = 'user-xyz';
    const lastReadMessageId = 'msg-final';

    mockFindFirst
      .mockResolvedValueOnce({ id: 'm1', userId, conversationId: 'conv-2' })
      .mockResolvedValueOnce({ id: lastReadMessageId, conversationId: 'conv-2' });

    const setFn = vi.fn().mockReturnThis();
    const whereFn = vi.fn().mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: whereFn });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId: 'conv-2', lastReadMessageId });

    expect(setFn).toHaveBeenCalledWith({ lastReadMessageId });
    expect(whereFn).toHaveBeenCalled();
  });
});
