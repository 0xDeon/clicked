import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockUserFindFirst = vi.fn();
const mockConversationMemberFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockUpdate = vi.fn();

const mockFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: { findFirst: mockUserFindFirst },
      conversationMembers: {
        findFirst: mockConversationMemberFindFirst,
        findMany: mockFindMany,
      },
      messages: { findFirst: mockMessageFindFirst, findMany: mockFindMany },
    },
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  conversations: {},
  messages: {},
  messageEnvelopes: {},
  users: {},
}));

// Keep these unit tests isolated from the CI Redis service so the
// if (redis) branch in message_read never runs here.
vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  lt: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'lt' })),
  lte: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
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
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  sql: vi.fn(),
}));

// ── Mock Socket helpers ────────────────────────────────────────────────────

function makeSocket(userId: string) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];

  const socket = Object.assign(emitter, {
    auth: { userId, deviceId: 'device-1' },
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

// Handlers now run exclusively through the enveloped 'dispatch' path (#342)
// — there's no more raw socket.on(type, ...) listener to grab directly.
let envelopeSeq = 0;
async function dispatchEnvelope(socket: EventEmitter, type: string, payload: unknown) {
  envelopeSeq += 1;
  EventEmitter.prototype.emit.call(socket, 'dispatch', {
    eventId: `test-evt-${envelopeSeq}`,
    type,
    timestamp: Date.now(),
    payload,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('message_read socket event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockUserFindFirst.mockResolvedValue({ id: 'user-abc', sendReadReceipts: true });
  });

  it('persists last_read_message_id and broadcasts read_receipt', async () => {
    const userId = 'user-abc';
    const conversationId = 'conv-1';
    const lastReadMessageId = 'msg-99';
    const lastReadMessage = { id: lastReadMessageId, conversationId, createdAt: new Date() };

    mockConversationMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId,
      conversationId,
    });
    mockMessageFindFirst.mockResolvedValueOnce(lastReadMessage);

    const setFn = vi.fn().mockReturnThis();
    const whereFn = vi.fn().mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: whereFn });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    await dispatchEnvelope(socket, 'message_read', { conversationId, lastReadMessageId });

    expect(mockUpdate).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({ lastReadMessageId });
    expect(io.to).toHaveBeenCalledWith(conversationId);
  });

  it('suppresses read_receipt fan-out when the user disables read receipts', async () => {
    const userId = 'user-hidden';
    const conversationId = 'conv-privacy';
    const lastReadMessageId = 'msg-privacy';

    mockFindFirst
      .mockResolvedValueOnce({ id: 'membership-1', userId, conversationId })
      .mockResolvedValueOnce({ id: lastReadMessageId, conversationId });
    mockUserFindFirst.mockResolvedValueOnce({ sendReadReceipts: false });

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

    expect(mockUpdate).toHaveBeenCalledTimes(2); // once for member, once for envelopes
    expect(setFn).toHaveBeenCalledWith({ lastReadMessageId });
    expect(io.to).toHaveBeenCalledWith(conversationId);
    expect(io.roomEmitted[0].event).toBe('read_receipt');
  });

  it('emits error when caller is not a conversation member', async () => {
    const socket = makeSocket('outsider');
    const io = makeIo();

    mockConversationMemberFindFirst.mockResolvedValueOnce(undefined); // no membership

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    await dispatchEnvelope(socket, 'message_read', {
      conversationId: 'conv-x',
      lastReadMessageId: 'msg-1',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'message_read',
        message: expect.stringContaining('member'),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('emits error when message is not found in the conversation', async () => {
    const userId = 'user-abc';
    mockConversationMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId,
      conversationId: 'conv-1',
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined); // message not found

    const setFn = vi.fn().mockReturnThis();
    mockUpdate.mockReturnValue({ set: setFn });

    const socket = makeSocket(userId);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    await dispatchEnvelope(socket, 'message_read', {
      conversationId: 'conv-1',
      lastReadMessageId: 'wrong-msg',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'message_read',
        message: expect.stringContaining('Message not found in conversation'),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('suppresses broadcast when user has sendReadReceipts disabled', async () => {
    const userId = 'user-private';
    const conversationId = 'conv-privacy';
    const lastReadMessageId = 'msg-secret';
    const lastReadMessage = {
      id: lastReadMessageId,
      conversationId,
      createdAt: new Date(),
    };

    mockUserFindFirst.mockResolvedValueOnce({ id: userId, sendReadReceipts: false });
    mockConversationMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-p',
      userId,
      conversationId,
    });
    mockMessageFindFirst.mockResolvedValueOnce(lastReadMessage);

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

    expect(mockUpdate).toHaveBeenCalledTimes(2); // member and envelopes are still updated
    expect(io.to).not.toHaveBeenCalled();
  });

  it('rejects backwards or stale updates to lastReadMessageId', async () => {
    const userId = 'user-abc';
    const conversationId = 'conv-1';
    const oldMessageDate = new Date('2026-01-01T00:00:00Z');
    const newMessageDate = new Date('2026-01-01T00:00:01.000Z');

    mockConversationMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId,
      conversationId,
      lastReadMessageId: 'msg-new',
    });

    // first for incoming message, second for existing lastReadMessageId
    mockMessageFindFirst
      .mockResolvedValueOnce({
        id: 'msg-old',
        conversationId,
        createdAt: oldMessageDate,
      })
      .mockResolvedValueOnce({
        id: 'msg-new',
        conversationId,
        createdAt: newMessageDate,
      });

    const socket = makeSocket(userId);
    const io = makeIo();
    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);
    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId, lastReadMessageId: 'msg-old' });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  it('stamps readAt on message envelopes for the reading device', async () => {
    const userId = 'user-abc';
    const deviceId = 'device-1';
    const conversationId = 'conv-1';
    const lastReadMessageId = 'msg-99';
    const lastReadMessage = { id: lastReadMessageId, conversationId, createdAt: new Date() };

    mockConversationMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId,
      conversationId,
    });
    mockMessageFindFirst.mockResolvedValueOnce(lastReadMessage);

    // Mock messages to be marked as read
    const messagesToUpdate = [{ id: 'msg-98' }, { id: 'msg-99' }];
    mockFindMany.mockResolvedValueOnce(messagesToUpdate);

    const setFn = vi.fn().mockReturnThis();
    const whereFn = vi.fn().mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: whereFn });

    const socket = makeSocket(userId);
    socket.auth.deviceId = deviceId;
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({ conversationId, lastReadMessageId });

    // one update for conversationMembers, one for messageEnvelopes
    expect(mockUpdate).toHaveBeenCalledTimes(2);

    // Check the call to update messageEnvelopes
    const secondUpdateCall = mockUpdate.mock.calls[1];
    const setCall = setFn.mock.calls[1];
    const whereCall = whereFn.mock.calls[1];

    expect(secondUpdateCall).toBeDefined();
    expect(setCall[0].readAt).toBeInstanceOf(Date);
    expect(whereCall[0]).toEqual(
      expect.arrayContaining([
        { col: {}, val: deviceId },
        { col: {}, vals: ['msg-98', 'msg-99'] },
        { col: {}, op: 'isNull' },
      ]),
    );
  });
});
