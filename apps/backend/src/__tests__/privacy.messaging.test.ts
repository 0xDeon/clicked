import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const conversationsTable = { name: 'conversations' };
const conversationMembersTable = { name: 'conversation_members' };

const mockUsersFindMany = vi.fn();
const mockConversationMembersFindFirst = vi.fn();
const mockConversationMembersFindMany = vi.fn();
const mockMessagesFindFirst = vi.fn();
const mockFilesFindFirst = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockInsertConversationsReturning = vi.fn();
const mockInsertConversationsValues = vi.fn(() => ({
  returning: mockInsertConversationsReturning,
}));
const mockInsertConversationMembersValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn((table: unknown) => {
  if (table === conversationsTable) {
    return { values: mockInsertConversationsValues };
  }
  if (table === conversationMembersTable) {
    return { values: mockInsertConversationMembersValues };
  }
  return { values: vi.fn() };
});

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: { findMany: mockUsersFindMany },
      conversationMembers: {
        findFirst: mockConversationMembersFindFirst,
        findMany: mockConversationMembersFindMany,
      },
      messages: { findFirst: mockMessagesFindFirst },
      files: { findFirst: mockFilesFindFirst },
      devices: { findMany: mockDevicesFindMany },
    },
    insert: mockInsert,
    transaction: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  conversations: conversationsTable,
  conversationMembers: conversationMembersTable,
  messages: {},
  messageEnvelopes: {},
  devices: {},
  files: {},
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  lt: vi.fn(),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  or: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/push.js', () => ({
  sendPushForMessage: vi.fn(),
}));
vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));
vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/resumeStream.js', () => ({
  publishEphemeral: vi.fn().mockResolvedValue(undefined),
  readMissedEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/deliveryAggregation.js', () => ({
  handleDeviceDeliveryReceipt: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/roomManager.js', () => ({
  conversationRoom: (conversationId: string) => `room:${conversationId}`,
}));

function makeSocket() {
  const emitter = new EventEmitter();
  const emitted: Array<{ event: string; data: unknown }> = [];
  return Object.assign(emitter, {
    auth: { userId: 'user-1', deviceId: 'device-1' },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
      return true;
    }),
    to: vi.fn(() => ({ emit: vi.fn() })),
    join: vi.fn(),
    rooms: new Set<string>(),
    emitted,
  });
}

function makeIo() {
  return { to: vi.fn(() => ({ emit: vi.fn(), volatile: { emit: vi.fn() } })) };
}

describe('conversation privacy guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsersFindMany.mockResolvedValue([]);
    mockInsertConversationsReturning.mockResolvedValue([
      { id: 'conv-1', type: 'dm', name: null, createdAt: new Date() },
    ]);
  });

  it('blocks new direct-message conversations when the recipient opted out', async () => {
    mockUsersFindMany.mockResolvedValue([
      {
        id: 'user-2',
        allowDirectMessages: false,
        allowGroupInvites: true,
      },
    ]);

    const socket = makeSocket();
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('create_conversation')[0] as (
      payload: unknown,
    ) => Promise<void>;
    await handler({ type: 'dm', memberIds: ['user-2'] });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'create_conversation',
        message: 'One or more recipients are not accepting direct messages',
        blockedUserIds: ['user-2'],
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
