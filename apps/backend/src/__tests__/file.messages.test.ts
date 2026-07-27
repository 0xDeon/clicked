/**
 * Tests for file message construction (issues #228, #347).
 *
 * Validates that:
 *  - File messages reference a `ready` file authorized for the sender.
 *  - The handler rejects files that are not `ready` (pending, deleted, missing).
 *  - Access control: only the uploader may reference a file.
 *  - File must belong to the same conversation.
 *  - `send_file_message` routes through the exact same `deliverMessage`
 *    pipeline `send_message` uses — identical per-device fan-out.
 *  - Per-device envelopes are required and persisted; sibling-device
 *    coverage (#188) is enforced exactly like the text-message path.
 *  - Delivery is deduped by client-supplied `messageId`, matching send_message.
 *  - Offline push is dispatched via `dispatchOfflinePush` with the same
 *    recipient-device resolution as text messages.
 *  - `fileKey` is never inspected or stored by the server — it lives only
 *    inside each recipient's individually-sealed envelope ciphertext.
 *  - Non-members are rejected before any file check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ─────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockFileFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockInsert = vi.fn();
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockFindMany },
      messages: { findFirst: mockMessageFindFirst },
      files: { findFirst: mockFileFindFirst },
      devices: { findMany: mockDevicesFindMany },
    },
    insert: mockInsert,
    update: mockUpdate,
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return { db };
});

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  conversations: {},
  messages: {},
  messageEnvelopes: {},
  devices: {},
  files: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  inArray: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  or: vi.fn((...args: unknown[]) => args),
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

const mockDeliverMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: mockDeliverMessage,
  deviceRoom: (id: string) => `device:${id}`,
}));

const mockDispatchOfflinePush = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: mockDispatchOfflinePush,
  FILE_CONTENT_TYPES: new Set(['file', 'image', 'video', 'audio']),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId = 'device-sender') {
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
  const io = {
    to: vi.fn(() => ({
      emit: vi.fn((event: string, data: unknown) => {
        roomEmitted.push({ event, data });
      }),
    })),
    roomEmitted,
  };
  return io;
}

const SENDER_ID = 'user-sender';
const SENDER_DEVICE_ID = 'device-sender';
const CONVERSATION_ID = 'conv-1';
const FILE_ID = 'file-abc';
const MESSAGE_ID = 'msg-1';
const RECIPIENT_DEVICE_ID = 'device-recipient';

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

function basePayload(
  overrides: Partial<{
    conversationId: string;
    messageId: string;
    fileId: string;
    content: string;
    contentType: 'file' | 'image' | 'video' | 'audio';
    envelopes: Array<{ recipientDeviceId: string; ciphertext: string }>;
  }> = {},
) {
  return {
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    fileId: FILE_ID,
    content: ENVELOPE_CIPHERTEXT,
    contentType: 'image' as const,
    envelopes: FILE_KEY_ENVELOPES,
    ...overrides,
  };
}

async function getHandler(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return socket.listeners('send_file_message')[0] as (p: unknown) => Promise<void>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — clears queued mockResolvedValueOnce
  // values too, so a test that returns early before consuming a queued value
  // can't leak it into the next test's first call.
  vi.resetAllMocks();

  mockDeliverMessage.mockResolvedValue(undefined);
  mockDispatchOfflinePush.mockResolvedValue(undefined);
  mockMessageFindFirst.mockResolvedValue(undefined); // no pre-existing message by default
  mockDevicesFindMany.mockResolvedValue([{ id: RECIPIENT_DEVICE_ID, userId: 'user-2' }]);

  // No sibling devices for the sender by default (fetchSiblingDeviceIds -> devices.findMany).
  // Overridden per-test via mockDevicesFindMany.mockResolvedValueOnce where needed.

  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ newSeq: 1 }]),
  });
});

describe('send_file_message socket event', () => {
  it('inserts a file message, persists envelopes, and delivers via the standard pipeline', async () => {
    const returnedMessage = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      senderDeviceId: SENDER_DEVICE_ID,
      ciphertext: ENVELOPE_CIPHERTEXT,
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
    // fetchSiblingDeviceIds call: no siblings for the sender.
    mockDevicesFindMany.mockResolvedValueOnce([]);
    // envelope device lookup inside the transaction.
    mockDevicesFindMany.mockResolvedValueOnce([{ id: RECIPIENT_DEVICE_ID, userId: 'user-2' }]);
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }, { userId: 'user-2' }]);

    const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    const envelopeValuesFn = vi.fn().mockResolvedValue(undefined);
    mockInsert
      .mockReturnValueOnce({ values: valuesFn })
      .mockReturnValueOnce({ values: envelopeValuesFn });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

    // Message was inserted with the client-supplied id and sender device.
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        senderDeviceId: SENDER_DEVICE_ID,
        fileId: FILE_ID,
        contentType: 'image',
      }),
    );

    // Envelope carrying the encrypted file key was persisted.
    expect(envelopeValuesFn).toHaveBeenCalledWith([
      expect.objectContaining({
        messageId: MESSAGE_ID,
        recipientDeviceId: RECIPIENT_DEVICE_ID,
        recipientUserId: 'user-2',
        ciphertext: FILE_KEY_ENVELOPES[0]!.ciphertext,
      }),
    ]);

    // Delivery goes through the same pipeline send_message uses.
    expect(mockDeliverMessage).toHaveBeenCalledWith(io, returnedMessage, CONVERSATION_ID);
    expect(mockDispatchOfflinePush).toHaveBeenCalledWith(CONVERSATION_ID, MESSAGE_ID, [
      RECIPIENT_DEVICE_ID,
    ]);
    expect(socket.emit).toHaveBeenCalledWith(
      'message_ack',
      expect.objectContaining({ messageId: MESSAGE_ID }),
    );
  });

  it('rejects when messageId is missing', async () => {
    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

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

    await handler(basePayload({ envelopes: [] }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('envelopes'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('acks without re-inserting when messageId was already persisted (idempotent retry)', async () => {
    const createdAt = new Date();
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile());
    mockMessageFindFirst.mockResolvedValueOnce({ createdAt });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

    expect(socket.emit).toHaveBeenCalledWith('message_ack', { messageId: MESSAGE_ID, createdAt });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDeliverMessage).not.toHaveBeenCalled();
  });

  it('rejects when envelopes are missing coverage for a sibling device (#188 parity)', async () => {
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(undefined); // file missing

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload({ fileId: 'nonexistent-file' }));

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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ status: 'pending' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload({ contentType: 'file' }));

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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ status: 'deleted' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload({ contentType: 'file' }));

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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ conversationId: 'conv-other' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: 'other-user',
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ uploaderId: SENDER_ID }));

    const socket = makeSocket('other-user');
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload({ contentType: 'video' }));

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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload({ content: '   ', contentType: 'audio' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'send_file_message',
        message: expect.stringContaining('empty'),
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('fileKey inside envelope ciphertext is never extracted or stored on the message row', async () => {
    // The server must treat both `content` and each envelope's `ciphertext`
    // as opaque blobs. Verify the inserted message row has no top-level
    // `fileKey` field — the key must remain only inside envelope ciphertext.
    const returnedMessage = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      senderDeviceId: SENDER_DEVICE_ID,
      ciphertext: ENVELOPE_CIPHERTEXT,
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
    mockDevicesFindMany.mockResolvedValueOnce([]); // no siblings
    mockDevicesFindMany.mockResolvedValueOnce([{ id: RECIPIENT_DEVICE_ID, userId: 'user-2' }]);
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }]);

    const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    const envelopeValuesFn = vi.fn().mockResolvedValue(undefined);
    mockInsert
      .mockReturnValueOnce({ values: valuesFn })
      .mockReturnValueOnce({ values: envelopeValuesFn });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler(basePayload());

    const insertedValues = (valuesFn.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(insertedValues).not.toHaveProperty('fileKey');
    expect(insertedValues.ciphertext).toBe(ENVELOPE_CIPHERTEXT);

    const insertedEnvelopes = (envelopeValuesFn.mock.calls[0] as unknown[])[0] as Array<
      Record<string, unknown>
    >;
    expect(insertedEnvelopes[0]).not.toHaveProperty('fileKey');
    expect(insertedEnvelopes[0]!.ciphertext).toBe(FILE_KEY_ENVELOPES[0]!.ciphertext);
  });

  it('supports all valid file content types: file, image, video, audio', async () => {
    const contentTypes = ['file', 'image', 'video', 'audio'] as const;

    for (const contentType of contentTypes) {
      vi.clearAllMocks();
      mockMessageFindFirst.mockResolvedValue(undefined);

      const returnedMessage = {
        id: `msg-${contentType}`,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        senderDeviceId: SENDER_DEVICE_ID,
        ciphertext: ENVELOPE_CIPHERTEXT,
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
      mockDevicesFindMany.mockResolvedValueOnce([]); // no siblings
      mockDevicesFindMany.mockResolvedValueOnce([{ id: RECIPIENT_DEVICE_ID, userId: 'user-2' }]);
      mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }]);

      const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
      const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
      const envelopeValuesFn = vi.fn().mockResolvedValue(undefined);
      mockInsert
        .mockReturnValueOnce({ values: valuesFn })
        .mockReturnValueOnce({ values: envelopeValuesFn });

      const socket = makeSocket(SENDER_ID);
      const io = makeIo();
      const handler = await getHandler(socket, io);

      await handler(basePayload({ messageId: `msg-${contentType}`, contentType }));

      expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ contentType }));
      expect(mockDeliverMessage).toHaveBeenCalledWith(io, returnedMessage, CONVERSATION_ID);
    }
  });
});
