import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMessagesFindFirst = vi.fn();
const mockMembersFindMany = vi.fn();
const mockDevicesFindMany = vi.fn();

const mockReturning = vi.fn();
// values() must work both as `.values(x).returning()` (message insert) and as
// `await db.insert(...).values(x)` (envelope insert), so it returns a thenable
// that also exposes returning().
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  then: (resolve: (value: unknown) => void) => resolve(undefined),
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockUpdateReturning = vi.fn();
const mockUpdate = vi.fn(() => ({
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: mockUpdateReturning,
}));

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: vi.fn(), findMany: mockMembersFindMany },
      messages: { findFirst: mockMessagesFindFirst },
      devices: { findMany: mockDevicesFindMany },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn(),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return { db };
});

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: {},
  messages: {},
  messageEnvelopes: {},
  devices: {},
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn(
    async (
      io: { to: (r: string) => { emit: (e: string, d: unknown) => void } },
      message: unknown,
      conversationId: string,
    ) => {
      io.to(conversationId).emit('new_message', message);
    },
  ),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

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

// ── Socket helpers ───────────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId: string) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];
  return Object.assign(emitter, {
    auth: { userId, deviceId },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    join: vi.fn(),
    emitted,
  });
}

function makeIo() {
  const roomEmitted: { event: string; data: unknown }[] = [];
  const emitFn = vi.fn((event: string, data: unknown) => {
    roomEmitted.push({ event, data });
  });
  return {
    to: vi.fn(() => ({ emit: emitFn, volatile: { emit: emitFn } })),
    roomEmitted,
  };
}

// Handlers now run exclusively through the enveloped 'dispatch' path (#342)
// — there's no more raw socket.on(type, ...) listener to grab directly.
let envelopeSeq = 0;
async function getHandler(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return async (payload: unknown) => {
    envelopeSeq += 1;
    EventEmitter.prototype.emit.call(socket, 'dispatch', {
      eventId: `test-evt-${envelopeSeq}`,
      type: 'edit_message',
      timestamp: Date.now(),
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
}

const USER_ID = 'sender-1';
const DEVICE_ID = 'device-1';
const CONVERSATION_ID = 'conv-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockMembersFindMany.mockResolvedValue([]);
  mockDevicesFindMany.mockResolvedValue([]);
  mockReturning.mockResolvedValue([
    { id: 'new-msg', createdAt: new Date('2024-01-01T00:00:05.000Z') },
  ]);
});

describe('edit_message socket event', () => {
  it('rejects when originalMessageId or messageId is missing', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({ messageId: 'new-msg', ciphertext: 'x' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'edit_message' }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the new content is empty', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({ originalMessageId: 'orig', messageId: 'new-msg' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.stringContaining('empty') }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects edits from anyone other than the original sender', async () => {
    mockMessagesFindFirst.mockResolvedValueOnce({
      id: 'orig',
      senderId: 'someone-else',
      conversationId: CONVERSATION_ID,
      editsMessageId: null,
      contentType: 'text/plain',
    });

    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({ originalMessageId: 'orig', messageId: 'new-msg', ciphertext: 'cipher' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ message: expect.stringContaining('original sender') }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('creates a linked new message and broadcasts new_message + message_edited', async () => {
    mockMessagesFindFirst
      .mockResolvedValueOnce({
        id: 'orig',
        senderId: USER_ID,
        conversationId: CONVERSATION_ID,
        editsMessageId: null,
        contentType: 'text/plain',
      })
      .mockResolvedValueOnce(undefined); // idempotency check: not seen before

    const socket = makeSocket(USER_ID, DEVICE_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ originalMessageId: 'orig', messageId: 'new-msg', ciphertext: 'cipher' });

    // New row links back to the original via editsMessageId.
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-msg',
        senderId: USER_ID,
        editsMessageId: 'orig',
        ciphertext: 'cipher',
      }),
    );

    const events = io.roomEmitted.map((e) => e.event);
    expect(events).toContain('new_message');
    expect(io.roomEmitted).toContainEqual({
      event: 'message_edited',
      data: { originalMessageId: 'orig', newMessageId: 'new-msg' },
    });
    expect(socket.emit).toHaveBeenCalledWith(
      'message_ack',
      expect.objectContaining({ messageId: 'new-msg' }),
    );
  });

  it('links an edit-of-an-edit back to the root original', async () => {
    mockMessagesFindFirst
      .mockResolvedValueOnce({
        id: 'v2',
        senderId: USER_ID,
        conversationId: CONVERSATION_ID,
        editsMessageId: 'root', // editing an already-edited message
        contentType: 'text/plain',
      })
      .mockResolvedValueOnce(undefined);

    const socket = makeSocket(USER_ID, DEVICE_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ originalMessageId: 'v2', messageId: 'v3', ciphertext: 'cipher' });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'v3', editsMessageId: 'root' }),
    );
    expect(io.roomEmitted).toContainEqual({
      event: 'message_edited',
      data: { originalMessageId: 'root', newMessageId: 'v3' },
    });
  });

  it('is idempotent: a replayed edit id acks without inserting again', async () => {
    mockMessagesFindFirst
      .mockResolvedValueOnce({
        id: 'orig',
        senderId: USER_ID,
        conversationId: CONVERSATION_ID,
        editsMessageId: null,
        contentType: 'text/plain',
      })
      .mockResolvedValueOnce({ createdAt: new Date('2024-01-01T00:00:09.000Z') }); // already exists

    const socket = makeSocket(USER_ID, DEVICE_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ originalMessageId: 'orig', messageId: 'dup', ciphertext: 'cipher' });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('message_ack', {
      messageId: 'dup',
      createdAt: new Date('2024-01-01T00:00:09.000Z'),
    });
    expect(io.roomEmitted.map((e) => e.event)).not.toContain('message_edited');
  });
});
