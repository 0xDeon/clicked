/**
 * Tests for file message construction (issues #228, #337).
 *
 * Validates that:
 *  - File messages reference a `ready` file authorized for the sender.
 *  - The handler rejects files that are not `ready` (pending, deleted, missing).
 *  - Access control: only the uploader may reference a file.
 *  - File must belong to the same conversation.
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
const mockMessageFindFirst = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockInsert = vi.fn();
const mockFindMany = vi.fn();
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

// The content is an E2EE envelope ciphertext for the message body. The server
// treats it as an opaque string. The file's symmetric encryption key must
// NEVER appear here — it only ever lives inside `envelopes[].ciphertext`.
const ENVELOPE_CIPHERTEXT = 'encrypted:{"fileId":"file-abc","fileName":"photo.jpg"}';
const FILE_KEY_ENVELOPES = [
  { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'sealed:SUPER_SECRET_KEY_NEVER_STORED' },
];

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

function insertedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    senderId: SENDER_ID,
    senderDeviceId: SENDER_DEVICE,
    ciphertext: ENVELOPE_CIPHERTEXT,
    contentType: 'image',
    fileId: FILE_ID,
    createdAt: new Date('2024-01-01T00:00:01.000Z'),
    deletedAt: null,
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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does not require envelopes for revoked sibling devices', async () => {
    // fetchSiblingDeviceIds filters revoked devices at the DB level, so a
    // sender whose only other device is revoked sees no siblings at all.
    mockDevicesFindMany.mockResolvedValue([]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('re-acks without re-inserting when the client messageId already exists', async () => {
    const createdAt = new Date('2024-01-01T00:00:07.000Z');
    mockMessageFindFirst.mockResolvedValue({ createdAt });

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'audio',
      envelopes: [{ recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' }],
    });

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(deliverMessage).toHaveBeenCalledWith(io, message, CONVERSATION_ID);

    // The handler itself performs no direct room emit — everything the room
    // sees comes from the pipeline.
    expect(io.roomEmitted.filter((e) => e.event === 'new_message')).toHaveLength(1);
  });

  it('acks the sender once the message is persisted', async () => {
    const message = insertedMessage();
    mockReturning.mockResolvedValue([message]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    expect(socket.emit).toHaveBeenCalledWith('message_ack', {
      messageId: message.id,
      createdAt: message.createdAt,
    });
  });

  it('dispatches offline push for the envelope recipients, not the legacy path', async () => {
    mockDevicesFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: BOB_DEVICE, userId: 'user-bob' },
      { id: 'device-carol', userId: 'user-carol' },
    ]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'video',
      envelopes: [
        { recipientDeviceId: BOB_DEVICE, ciphertext: 'cipher-for-bob' },
        { recipientDeviceId: 'device-carol', ciphertext: 'cipher-for-carol' },
      ],
    });

    expect(dispatchOfflinePush).toHaveBeenCalledWith('conv-1', 'msg-1', [
      BOB_DEVICE,
      'device-carol',
    ]);
    // The old uncoalesced file-message push path is no longer used, so a file
    // message can't be pushed twice via two different mechanisms.
    expect(sendPushForMessage).not.toHaveBeenCalled();
  });

  it('does not deliver when the transaction fails', async () => {
    mockReturning.mockRejectedValue(new Error('db down'));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

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
        message: expect.stringContaining('Failed to persist'),
      }),
    );
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(dispatchOfflinePush).not.toHaveBeenCalled();
  });
});

describe('send_file_message — validation and access control', () => {
  it('rejects when sender is not a member of the conversation', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    await handler(basePayload({ messageId: '' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('messageId'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when envelopes are missing (the file key has nowhere safe to travel)', async () => {
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile());
    // fetchSiblingDeviceIds finds one sibling device the payload didn't cover.
    mockDevicesFindMany.mockResolvedValueOnce([{ id: 'device-sibling', userId: SENDER_ID }]);

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'device_set_mismatch',
        missingDeviceIds: ['device-sibling'],
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when sender is not a member of the conversation', async () => {
    mockMemberFindFirst.mockResolvedValueOnce(undefined); // no membership

    const socket = makeSocket('non-member');
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: 'nonexistent-file',
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'file',
    });

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'file',
    });

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'video',
    });

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

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: '   ',
      contentType: 'audio',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('empty'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects an unsupported contentType', async () => {
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'text',
    });

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
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({
      conversationId: CONVERSATION_ID,
      fileId: FILE_ID,
      content: ENVELOPE_CIPHERTEXT,
      contentType: 'image',
    });

    // The inserted values must not include a top-level `fileKey` field.
    expect(messageRow()).not.toHaveProperty('fileKey');
    // The ciphertext is stored as-is (opaque encrypted blob).
    expect(messageRow().ciphertext).toBe(ENVELOPE_CIPHERTEXT);
  });

  it('supports all valid file content types: file, image, video, audio', async () => {
    const contentTypes = ['file', 'image', 'video', 'audio'] as const;

    for (const contentType of contentTypes) {
      insertCalls.length = 0;
      mockDevicesFindMany.mockResolvedValue([]);

      const socket = makeSocket(SENDER_ID);
      const io = makeIo();
      const handler = await getHandler(socket, io);

      await handler({
        conversationId: CONVERSATION_ID,
        fileId: FILE_ID,
        content: ENVELOPE_CIPHERTEXT,
        contentType,
      });

      expect(messageRow()).toMatchObject({ contentType });
    }
  });
});
