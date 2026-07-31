/**
 * Tests for file message construction (issues #228, #337).
 *
 * Validates that:
 *  - The handler calls the shared `validateMessagePayload` (#335).
 *  - File messages reference a `ready` file authorized for the sender.
 *  - The handler rejects files that are not `ready` (pending, deleted, missing).
 *  - Access control: only the uploader may reference a file.
 *  - File must belong to the same conversation.
 *  - Fan-out via io.to(conversationId).emit('new_message') is identical to
 *    the text-message path.
 *  - `fileKey` is never inspected or stored by the server — it lives only
 *    inside the encrypted `content` envelope ciphertext.
 *  - Envelopes are required, matching the text-message path.
 *  - Non-members are rejected before any file check.
 *  - `fileKey` is never inspected or stored by the server — it lives only
 *    inside the encrypted envelope ciphertext.
 *
 * Envelope migration (#337): `send_file_message` used to persist a single
 * shared `messages.ciphertext` with zero `message_envelopes` rows and fan out
 * with a raw `io.to(conversationId).emit('new_message', …)`. It now mirrors
 * `send_message` exactly:
 *  - per-device envelopes are inserted inside the message transaction,
 *  - sibling-device coverage is enforced (`device_set_mismatch`, #188),
 *  - a client-supplied messageId is idempotent,
 *  - delivery goes through the standard `deliverMessage` pipeline,
 *  - push goes through `dispatchOfflinePush`, not `sendPushForMessage`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import { messages as messagesTable, messageEnvelopes } from '../db/schema.js';
import { deliverMessage } from '../services/deliveryPipeline.js';
import { dispatchOfflinePush } from '../services/pushNotification.js';
import { sendPushForMessage } from '../services/push.js';

// ── Mock DB ─────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockFileFindFirst = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockUpdate = vi.fn();

/** Every insert(table).values(rows) call, so envelope rows can be asserted. */
const insertCalls: { table: unknown; values: unknown }[] = [];
const mockReturning = vi.fn();

// values() must work both as `.values(x).returning()` (message insert) and as
// `await tx.insert(...).values(x)` (envelope insert), so it returns a thenable
// that also exposes returning().
const mockInsert = vi.fn((table: unknown) => ({
  values: (rows: unknown) => {
    insertCalls.push({ table, values: rows });
    return {
      returning: mockReturning,
      then: (resolve: (value: unknown) => void) => resolve(undefined),
    };
  },
}));

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      messages: { findFirst: mockMessageFindFirst },
      files: { findFirst: mockFileFindFirst },
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
  conversationMembers: { __table: 'conversation_members' },
  conversations: { __table: 'conversations' },
  messages: { __table: 'messages' },
  messageEnvelopes: { __table: 'message_envelopes' },
  devices: { __table: 'devices' },
  files: { __table: 'files' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../lib/validateMessagePayload.js', () => ({
  validateMessagePayload: vi.fn().mockReturnValue({ ok: true }),
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

// Delivery now goes through the shared pipeline. The mock still performs the
// room emit so fan-out can be observed, but assertions target deliverMessage.
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

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(['file', 'image', 'video', 'audio']),
}));

vi.mock('../services/push.js', () => ({
  sendPushForMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId = SENDER_DEVICE) {
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
  return {
    to: vi.fn(() => ({ emit: emitFn, volatile: { emit: emitFn } })),
    roomEmitted,
  };
}

async function getHandler(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return socket.listeners('send_file_message')[0] as (p: unknown) => Promise<void>;
}

/** Rows handed to insert(messageEnvelopes).values(...) during the transaction. */
function envelopeRows(): Array<Record<string, unknown>> {
  const call = insertCalls.find((c) => c.table === messageEnvelopes);
  return (call?.values as Array<Record<string, unknown>>) ?? [];
}

function messageRow(): Record<string, unknown> {
  const call = insertCalls.find((c) => c.table === messagesTable);
  return (call?.values as Record<string, unknown>) ?? {};
}

const SENDER_ID = 'user-sender';
const SENDER_DEVICE = 'device-sender';
const SIBLING_B = 'device-sibling-b';
const SIBLING_C = 'device-sibling-c';
const BOB_DEVICE = 'device-bob';
const CONVERSATION_ID = 'conv-1';
const FILE_ID = 'file-abc';
const MESSAGE_ID = 'msg-client-supplied';

const ENVELOPES = [
  { recipientDeviceId: 'dev-recipient-1', ciphertext: 'for-recipient-1' },
  { recipientDeviceId: 'dev-sender-sibling', ciphertext: 'for-sender-sibling' },
];
// The content is an E2EE envelope ciphertext for the message body. The server
// treats it as an opaque string. The file's symmetric encryption key must
// NEVER appear here — it only ever lives inside `envelopes[].ciphertext`.
const ENVELOPE_CIPHERTEXT = 'encrypted:{"fileId":"file-abc","fileName":"photo.jpg"}';

function readyFile(
  overrides: Partial<{
    id: string;
    uploaderId: string;
    conversationId: string;
    status: string;
  }> = {},
) {
  return {
    id: FILE_ID,
    uploaderId: SENDER_ID,
    conversationId: CONVERSATION_ID,
    status: 'ready',
    ...overrides,
  };
}

function fileMessagePayload(
  overrides: Partial<{
    conversationId: string;
    fileId: string;
    messageId: string;
    content: string;
    contentType: 'file' | 'image' | 'video' | 'audio';
  }> = {},
) {
  return {
    conversationId: CONVERSATION_ID,
    fileId: FILE_ID,
    messageId: DEFAULT_MESSAGE_ID,
    content: ENVELOPE_CIPHERTEXT,
    contentType: 'image' as const,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;

  mockMemberFindFirst.mockReset().mockResolvedValue({
    id: 'membership-1',
    userId: SENDER_ID,
    conversationId: CONVERSATION_ID,
  });
  mockMemberFindMany.mockReset().mockResolvedValue([{ userId: SENDER_ID }, { userId: 'user-bob' }]);
  mockMessageFindFirst.mockReset().mockResolvedValue(undefined);
  mockFileFindFirst.mockReset().mockResolvedValue(readyFile());
  mockDevicesFindMany.mockReset().mockResolvedValue([]);
  mockReturning.mockReset().mockResolvedValue([insertedMessage()]);

  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ newSeq: 1 }]),
  });
});

describe('send_file_message — per-device envelopes (#337)', () => {
  it('inserts the message and its envelopes inside the same transaction', async () => {
    mockDevicesFindMany
      // fetchSiblingDeviceIds → sender owns one sibling device
      .mockResolvedValueOnce([{ id: SIBLING_B }])
      // envelope fan-out → resolve each recipient device to its owning user
      .mockResolvedValueOnce([
        { id: SIBLING_B, userId: SENDER_ID },
        { id: BOB_DEVICE, userId: 'user-bob' },
      ]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
      envelopes: [
        { recipientDeviceId: SIBLING_B, ciphertext: 'cipher-for-sibling' },
        { recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' },
      ],
    });

    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);

    // Message row carries the sending device, so recipients can attribute it.
    expect(messageRow()).toMatchObject({
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      senderDeviceId: SENDER_DEVICE,
      contentType: 'image',
      fileId: FILE_ID,
      createdAt: new Date(),
      deletedAt: null,
      envelopes: ENVELOPES,
    });

    // One envelope row per recipient device, each with its own ciphertext and
    // the resolved owning user id.
    expect(envelopeRows()).toEqual([
      {
        messageId: 'msg-1',
        recipientDeviceId: SIBLING_B,
        recipientUserId: SENDER_ID,
        ciphertext: 'cipher-for-sibling',
      },
      {
        messageId: 'msg-1',
        recipientDeviceId: BOB_DEVICE,
        recipientUserId: 'user-bob',
        ciphertext: 'cipher-for-bob',
      },
    ]);

    // Both inserts ran through the same db.transaction callback.
    const { db } = (await import('../db/index.js')) as unknown as {
      db: { transaction: ReturnType<typeof vi.fn> };
    };
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('drops envelopes naming a device that no longer exists', async () => {
    mockDevicesFindMany
      .mockResolvedValueOnce([]) // no siblings
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: 'user-bob' }]); // 'ghost' not resolved

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'file',
      envelopes: [
        { recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' },
        { recipientDeviceId: 'device-ghost', ciphertext: 'cipher-for-ghost' },
      ],
    });

    expect(envelopeRows()).toHaveLength(1);
    expect(envelopeRows()[0]).toMatchObject({ recipientDeviceId: BOB_DEVICE });
  });

  it('rejects with device_set_mismatch when a sibling device envelope is missing', async () => {
    mockDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }, { id: SIBLING_C }]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    // Only sibling B is covered; sibling C is absent.
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
      envelopes: [{ recipientDeviceId: SIBLING_B, ciphertext: 'cipher-for-b' }],
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile());
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }, { userId: 'user-2' }]);

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect((errors[0]!.data as { missingDeviceIds: string[] }).missingDeviceIds).toEqual([
      SIBLING_C,
    ]);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects with device_set_mismatch when envelopes are omitted entirely but siblings exist', async () => {
    mockDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    // A non-empty envelopes array satisfies the file-key requirement, but it
    // doesn't cover the sender's sibling device — that's still a mismatch.
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'image',
      envelopes: ENVELOPES,
      envelopes: [{ recipientDeviceId: 'device-unrelated', ciphertext: 'cipher-for-unrelated' }],
    });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does not require sibling coverage for revoked sibling devices', async () => {
    // fetchSiblingDeviceIds filters revoked devices at the DB level, so a
    // sender whose only other device is revoked sees no siblings at all.
    mockDevicesFindMany.mockResolvedValue([]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'image' }));

    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    expect(mockInsert).toHaveBeenCalled();
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: returnedMessage.id,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        fileId: FILE_ID,
        contentType: 'image',
      }),
    );

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
      envelopes: [{ recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' }],
    });

    expect(socket.emit).toHaveBeenCalledWith('message_ack', { messageId: MESSAGE_ID, createdAt });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('uses the client-supplied messageId for the row and its envelopes', async () => {
    mockReturning.mockResolvedValue([insertedMessage({ id: MESSAGE_ID })]);
    mockDevicesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: 'user-bob' }]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
      envelopes: [{ recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' }],
    });

    expect(messageRow()).toMatchObject({ id: MESSAGE_ID });
    expect(envelopeRows()[0]).toMatchObject({ messageId: MESSAGE_ID });
  });
});

describe('send_file_message — delivery pipeline (#337)', () => {
  it('delivers through deliverMessage instead of a raw io.to().emit()', async () => {
    const message = insertedMessage();
    mockReturning.mockResolvedValue([message]);
    mockDevicesFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: 'user-bob' }]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: 'msg-not-member', contentType: 'file' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('Failed to persist'),
      }),
    );
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(dispatchOfflinePush).not.toHaveBeenCalled();
  });
});

describe('send_file_message — validation and access control', () => {
  it('rejects when envelopes are missing (the file key has nowhere safe to travel)', async () => {
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'file',
      envelopes: ENVELOPES,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('envelopes are required'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when sender is not a member of the conversation', async () => {
    mockMemberFindFirst.mockResolvedValueOnce(undefined); // no membership

    const socket = makeSocket('non-member');
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
      envelopes: [{ recipientDeviceId: 'device-recipient', ciphertext: 'sealed-file-key' }],
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('member'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the referenced file does not exist', async () => {
    mockFileFindFirst.mockResolvedValue(undefined);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: 'nonexistent-file',
      contentType: 'image',
      envelopes: ENVELOPES,
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    await handler(
      fileMessagePayload({
        messageId: 'msg-missing-file',
        fileId: 'nonexistent-file',
        contentType: 'image',
      }),
    );

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('not found'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the file status is pending (not ready)', async () => {
    mockFileFindFirst.mockResolvedValue(readyFile({ status: 'pending' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'file',
      envelopes: ENVELOPES,
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    await handler(fileMessagePayload({ messageId: 'msg-pending-file', contentType: 'file' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('not ready'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the file status is deleted', async () => {
    mockFileFindFirst.mockResolvedValue(readyFile({ status: 'deleted' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'file',
      envelopes: ENVELOPES,
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    await handler(fileMessagePayload({ messageId: 'msg-deleted-file', contentType: 'file' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('not ready'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the file belongs to a different conversation', async () => {
    mockFileFindFirst.mockResolvedValue(readyFile({ conversationId: 'conv-other' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'image',
      envelopes: ENVELOPES,
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    await handler(fileMessagePayload({ messageId: 'msg-wrong-conv', contentType: 'image' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('does not belong'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when a different user tries to reference a file they did not upload', async () => {
    mockMemberFindFirst.mockResolvedValue({
      id: 'm1',
      userId: 'other-user',
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValue(readyFile({ uploaderId: SENDER_ID }));

    const socket = makeSocket('other-user');
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'video',
      envelopes: ENVELOPES,
    });
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    await handler(fileMessagePayload({ messageId: 'msg-unauthorized', contentType: 'video' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('Access denied'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when content (envelope ciphertext) is empty', async () => {
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(
      fileMessagePayload({
        messageId: 'msg-empty-content',
        content: '   ',
        contentType: 'audio',
      }),
    );

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('empty'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('fan-out is identical to text message: io.to(conversationId).emit("new_message", message)', async () => {
    const returnedMessage = {
      id: 'msg-2',
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      contentType: 'audio',
      fileId: FILE_ID,
      createdAt: new Date(),
      deletedAt: null,
    };

    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile());
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }]);

    const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    mockInsert.mockReturnValue({ values: valuesFn });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'audio',
      envelopes: ENVELOPES,
    });
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'audio' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('contentType must be one of'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('fileKey inside envelope ciphertext is never extracted or stored by the server', async () => {
    // The server must treat envelope `ciphertext` as an opaque blob. We verify that the
    // insert values object does NOT contain a `fileKey` field — the key must
    // remain only inside the encrypted envelope ciphertext.
    const returnedMessage = {
      id: 'msg-3',
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      contentType: 'image',
      fileId: FILE_ID,
      createdAt: new Date(),
      deletedAt: null,
    };

    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile());
    mockMessageFindFirst.mockResolvedValueOnce(undefined);
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }]);

    const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    mockInsert.mockReturnValue({ values: valuesFn });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      contentType: 'image',
      envelopes: ENVELOPES,
    });

    // The inserted values must not include a top-level `fileKey` field
    const insertedValues = (valuesFn.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(insertedValues).not.toHaveProperty('fileKey');

    // The message row itself has no ciphertext; it's all in the envelopes.
    expect(insertedValues.ciphertext).toBeUndefined();
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'image' }));

    // The inserted values must not include a top-level `fileKey` field.
    expect(messageRow()).not.toHaveProperty('fileKey');
    // The ciphertext is stored as-is (opaque encrypted blob).
    expect(messageRow().ciphertext).toBe(ENVELOPE_CIPHERTEXT);
  });

  it('supports all valid file content types: file, image, video, audio', async () => {
    const contentTypes = ['file', 'image', 'video', 'audio'] as const;

    for (const contentType of contentTypes) {
      vi.clearAllMocks();

      const returnedMessage = {
        id: `msg-${contentType}`,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        contentType,
        fileId: FILE_ID,
        createdAt: new Date(),
        deletedAt: null,
      };

      mockMemberFindFirst.mockResolvedValueOnce({
        id: 'membership-1',
        userId: SENDER_ID,
        conversationId: CONVERSATION_ID,
      });
      mockFileFindFirst.mockResolvedValueOnce(readyFile());
      mockMessageFindFirst.mockResolvedValueOnce(undefined);
      mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }]);

      const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
      const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
      mockInsert.mockReturnValue({ values: valuesFn });

      const socket = makeSocket(SENDER_ID);
      const io = makeIo();
      const handler = await getHandler(socket, io);

      const { registerMessagingHandlers } = await import('../socket/messaging.js');
      registerMessagingHandlers(io as never, socket as never);

      const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
        p: unknown,
      ) => Promise<void>;
      await handler({
        conversationId: CONVERSATION_ID,
        fileId: FILE_ID,
        contentType,
        envelopes: ENVELOPES,
      });
      await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType }));

      expect(messageRow()).toMatchObject({ contentType });
    }
  });

  it('requires a messageId so retries can be idempotent', async () => {
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('messageId is required'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('acks duplicate messageIds without creating a second file message', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'membership-1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockMessageFindFirst.mockResolvedValueOnce({ createdAt });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: 'msg-duplicate', contentType: 'image' }));

    expect(socket.emit).toHaveBeenCalledWith('message_ack', {
      messageId: 'msg-duplicate',
      createdAt,
    });
    expect(mockFileFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
