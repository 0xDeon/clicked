/**
 * Tests for file message construction (issue #228).
 *
 * Validates that:
 *  - File messages reference a `ready` file authorized for the sender.
 *  - The handler rejects files that are not `ready` (pending, deleted, missing).
 *  - Access control: only the uploader may reference a file.
 *  - File must belong to the same conversation.
 *  - Fan-out via io.to(conversationId).emit('new_message') is identical to
 *    the text-message path.
 *  - `fileKey` is never inspected or stored by the server — it lives only
 *    inside the encrypted `content` envelope ciphertext.
 *  - Non-members are rejected before any file check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ─────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockFileFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockFindMany },
      messages: { findFirst: mockMessageFindFirst },
      files: { findFirst: mockFileFindFirst },
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
  files: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
const CONVERSATION_ID = 'conv-1';
const FILE_ID = 'file-abc';
const DEFAULT_MESSAGE_ID = 'msg-file-default';

// The content is an E2EE envelope ciphertext. The server treats it as an
// opaque string — it must NOT parse or store the embedded fileKey.
const ENVELOPE_CIPHERTEXT =
  'encrypted:{"fileId":"file-abc","fileName":"photo.jpg","mimeType":"image/jpeg","size":204800,"fileKey":"SUPER_SECRET_KEY_NEVER_STORED"}';

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

  // Default: the per-conversation sequence-number bump succeeds.
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ newSeq: 1 }]),
  });
});

describe('send_file_message socket event', () => {
  it('inserts a file message and fans out new_message when file is ready and sender owns it', async () => {
    const returnedMessage = {
      id: 'msg-1',
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      content: ENVELOPE_CIPHERTEXT,
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
    mockFindMany.mockResolvedValueOnce([{ userId: SENDER_ID }, { userId: 'user-2' }]);

    const returningFn = vi.fn().mockResolvedValue([returnedMessage]);
    const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
    mockInsert.mockReturnValue({ values: valuesFn });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'image' }));

    // Message was inserted
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

    // Fan-out to room — identical to text message path
    expect(io.to).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it('rejects when sender is not a member of the conversation', async () => {
    mockMemberFindFirst.mockResolvedValueOnce(undefined); // no membership

    const socket = makeSocket('non-member');
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: 'msg-not-member', contentType: 'file' }));

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

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ status: 'pending' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ status: 'deleted' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ conversationId: 'conv-other' }));

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: 'other-user',
      conversationId: CONVERSATION_ID,
    });
    mockFileFindFirst.mockResolvedValueOnce(readyFile({ uploaderId: SENDER_ID }));

    const socket = makeSocket('other-user');
    const io = makeIo();

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
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
    mockMemberFindFirst.mockResolvedValueOnce({
      id: 'm1',
      userId: SENDER_ID,
      conversationId: CONVERSATION_ID,
    });

    const socket = makeSocket(SENDER_ID);
    const io = makeIo();

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
      content: ENVELOPE_CIPHERTEXT,
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
    const innerEmit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit: innerEmit })),
      roomEmitted: [] as { event: string; data: unknown }[],
    };

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'audio' }));

    expect(io.to).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(innerEmit).toHaveBeenCalledWith('new_message', returnedMessage);
  });

  it('fileKey inside envelope ciphertext is never extracted or stored by the server', async () => {
    // The server must treat `content` as an opaque blob. We verify that the
    // insert values object does NOT contain a `fileKey` field — the key must
    // remain only inside the encrypted envelope ciphertext.
    const returnedMessage = {
      id: 'msg-3',
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      content: ENVELOPE_CIPHERTEXT,
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

    const { registerMessagingHandlers } = await import('../socket/messaging.js');
    registerMessagingHandlers(io as never, socket as never);

    const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
      p: unknown,
    ) => Promise<void>;
    await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType: 'image' }));

    // The inserted values must not include a top-level `fileKey` field
    const insertedValues = (valuesFn.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(insertedValues).not.toHaveProperty('fileKey');

    // The `ciphertext` field is stored as-is (opaque encrypted blob)
    expect(insertedValues.ciphertext).toBe(ENVELOPE_CIPHERTEXT);
  });

  it('supports all valid file content types: file, image, video, audio', async () => {
    const contentTypes = ['file', 'image', 'video', 'audio'] as const;

    for (const contentType of contentTypes) {
      vi.clearAllMocks();

      const returnedMessage = {
        id: `msg-${contentType}`,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: ENVELOPE_CIPHERTEXT,
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

      const { registerMessagingHandlers } = await import('../socket/messaging.js');
      registerMessagingHandlers(io as never, socket as never);

      const handler = (socket as EventEmitter).listeners('send_file_message')[0] as (
        p: unknown,
      ) => Promise<void>;
      await handler(fileMessagePayload({ messageId: returnedMessage.id, contentType }));

      expect(mockInsert).toHaveBeenCalled();
      expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ contentType }));
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
