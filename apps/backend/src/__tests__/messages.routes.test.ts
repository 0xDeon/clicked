import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockFindMessage = vi.fn();
const mockFindMembers = vi.fn();
const mockUpdate = vi.fn();

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockDelete = vi.fn();
let mockSocketServer: { to: typeof mockTo } | null = { to: mockTo };

vi.mock('../lib/socket.js', () => ({
  getSocketServer() {
    return mockSocketServer;
  },
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      messages: { findFirst: mockFindMessage },
      conversationMembers: { findMany: mockFindMembers },
    },
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    senderId: 'senderId',
    ciphertext: 'ciphertext',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
  },
  messageEnvelopes: { messageId: 'messageId' },
  tokenTransfers: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  desc: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../services/fileCleanup.js', () => ({
  softDeleteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'user-1' };
    next();
  },
}));

const { messagesRouter } = await import('../routes/messages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/messages', messagesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSocketServer = { to: mockTo };
});

describe('DELETE /messages/:id', () => {
  it('returns 403 when the caller is not the sender', async () => {
    mockFindMessage.mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'user-2',
      ciphertext: 'hello',
      deletedAt: null,
    });

    const res = await request(makeApp()).delete('/messages/msg-1');

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('soft-deletes the caller message and broadcasts message_deleted', async () => {
    mockFindMessage.mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'user-1',
      ciphertext: 'hello',
      deletedAt: null,
    });

    const setFn = vi.fn().mockReturnThis();
    const whereFn = vi.fn().mockResolvedValue([{ conversationId: 'conv-1' }]);
    const deleteWhereFn = vi.fn().mockResolvedValue([]);
    mockUpdate.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: whereFn });
    mockDelete.mockReturnValue({ where: deleteWhereFn });
    mockFindMembers.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

    const res = await request(makeApp()).delete('/messages/msg-1');

    expect(res.status).toBe(204);
    expect(setFn).toHaveBeenCalledWith({ deletedAt: expect.any(Date), ciphertext: null });
    expect(mockTo).toHaveBeenCalledWith('conv-1');
    expect(mockEmit).toHaveBeenCalledWith('message_deleted', {
      messageId: 'msg-1',
      conversationId: 'conv-1',
    });
  });
});
