import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockUserFindFirst = vi.fn();
const mockConversationMemberFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockFindMany = vi.fn();
let dbUpdateMock;

const setMock = vi.fn().mockReturnThis();
const whereMock = vi.fn().mockResolvedValue(undefined);
dbUpdateMock = vi.fn(() => ({ set: setMock, where: whereMock }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: { findFirst: mockUserFindFirst },
      conversationMembers: {
        findFirst: mockConversationMemberFindFirst,
        findMany: mockFindMany,
      },
      messages: { findFirst: mockMessageFindFirst, findMany: mockFindMany },
      messageEnvelopes: { findMany: mockFindMany },
    },
    update: dbUpdateMock,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: 'conversationMembers',
  messages: 'messages',
  messageEnvelopes: 'messageEnvelopes',
  users: 'users',
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('drizzle-orm', () => ({
  and: (...args) => `and(${args.join(', ')})`,
  eq: (col, val) => `eq(${col}, ${val})`,
  lt: (col, val) => `lt(${col}, ${val})`,
  lte: (col, val) => `lte(${col}, ${val})`,
  desc: (col) => `desc(${col})`,
  sql: (strings, ...values) => `sql(${strings.join('?')}, ${values.join(', ')})`,
  inArray: (col, values) => `inArray(${col}, [${values.join(', ')}])`,
  isNull: (col) => `isNull(${col})`,
}));

// ── Mock Socket helpers ────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId = 'device-1') {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];

  const socket = Object.assign(emitter, {
    auth: { userId, deviceId },
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

describe('[NEW] message_read socket event', () => {

  beforeEach(() => {
    vi.resetAllMocks();
    setMock.mockClear();
    whereMock.mockClear();
    dbUpdateMock.mockClear();
  });

  it('privacy-disabled suppresses broadcast', async () => {
    const userId = 'privacy-user';
    const conversationId = 'conv-privacy';
    const lastReadMessageId = 'msg-secret';

    mockUserFindFirst.mockResolvedValue({ id: userId, sendReadReceipts: false });
    mockConversationMemberFindFirst.mockResolvedValue({ id: 'cm-1', userId, conversationId });
    mockMessageFindFirst.mockResolvedValue({ id: lastReadMessageId, createdAt: new Date() });
    mockFindMany.mockResolvedValue([]);

    const socket = makeSocket(userId);
    const io = makeIo();
    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (p: any) => Promise<void>;
    await handler({ conversationId, lastReadMessageId });

    expect(io.to).not.toHaveBeenCalled();
    // Still expect DB updates for personal state
    expect(dbUpdateMock).toHaveBeenCalledWith('conversationMembers');
  });

  it('backwards update rejected', async () => {
    const userId = 'user-stale';
    const conversationId = 'conv-stale';
    const currentReadId = 'msg-10';
    const attemptedReadId = 'msg-5';

    mockUserFindFirst.mockResolvedValue({ id: userId, sendReadReceipts: true });
    mockConversationMemberFindFirst.mockResolvedValue({ id: 'cm-2', userId, conversationId, lastReadMessageId: currentReadId });
    
    const newerDate = new Date();
    const olderDate = new Date(newerDate.getTime() - 1000);

    // First call is for the attempted message, second is for the existing one.
    mockMessageFindFirst.mockResolvedValueOnce({ id: attemptedReadId, createdAt: olderDate });
    mockMessageFindFirst.mockResolvedValueOnce({ id: currentReadId, createdAt: newerDate });

    const socket = makeSocket(userId);
    const io = makeIo();
    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);
    
    const handler = (socket as EventEmitter).listeners('message_read')[0] as (p: any) => Promise<void>;
    await handler({ conversationId, lastReadMessageId: attemptedReadId });

    expect(dbUpdateMock).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  it('readAt persisted per envelope', async () => {
    const userId = 'user-readat';
    const deviceId = 'device-readat';
    const conversationId = 'conv-readat';
    const lastReadMessageId = 'msg-read';
    const now = new Date();

    mockUserFindFirst.mockResolvedValue({ id: userId, sendReadReceipts: true });
    mockConversationMemberFindFirst.mockResolvedValue({ id: 'cm-3', userId, conversationId });
    mockMessageFindFirst.mockResolvedValue({ id: lastReadMessageId, createdAt: now });

    const messagesToUpdate = [{ id: 'msg-1' }, { id: 'msg-2' }, { id: 'msg-read' }];
    mockFindMany.mockResolvedValueOnce(messagesToUpdate);

    const socket = makeSocket(userId, deviceId);
    const io = makeIo();
    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('message_read')[0] as (p: any) => Promise<void>;
    await handler({ conversationId, lastReadMessageId });

    // conversationMembers update + messageEnvelopes update
    expect(dbUpdateMock).toHaveBeenCalledTimes(2);
    
    const updateCall = dbUpdateMock.mock.calls[1];
    const setCall = setMock.mock.calls[1][0];

    expect(updateCall[0]).toBe('messageEnvelopes');
    expect(setCall.readAt).toBeInstanceOf(Date);
  });
});
