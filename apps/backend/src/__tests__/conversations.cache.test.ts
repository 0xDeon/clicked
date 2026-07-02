import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Redis mock ─────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockSetex = vi.fn();
const mockDel = vi.fn();

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return mockRedisInstance;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

let mockRedisInstance: {
  get: typeof mockGet;
  setex: typeof mockSetex;
  del: typeof mockDel;
} | null = {
  get: mockGet,
  setex: mockSetex,
  del: mockDel,
};

// ── DB mock ────────────────────────────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockExecute = vi.fn();
const mockGroupBy = vi.fn();
const mockWhere = vi.fn(() => ({ groupBy: mockGroupBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockFindMany, findFirst: mockFindFirst },
    },
    execute: mockExecute,
    select: mockSelect,
  },
}));

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => null,
}));

vi.mock('../db/schema.js', () => ({
  conversations: { id: 'id', type: 'type' },
  conversationMembers: {
    conversationId: 'conversationId',
    userId: 'userId',
    joinedAt: 'joinedAt',
    isArchived: 'isArchived',
  },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    senderId: 'senderId',
    ciphertext: 'ciphertext',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
  },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
}));
vi.mock('drizzle-orm', () => {
  const sqlMock = Object.assign(
    vi.fn(() => 'sql'),
    {
      join: vi.fn(() => 'joined'),
    },
  );

  return {
    and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
    asc: vi.fn(),
    count: vi.fn(() => 'count'),
    desc: vi.fn(),
    eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
    ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
    lt: vi.fn(),
    sql: sqlMock,
  };
});

// ── Auth middleware mock: always passes with test userId ───────────────────

const TEST_USER_ID = 'user-test-123';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: TEST_USER_ID,
      deviceId: 'device-test-123',
    };
    next();
  },
}));

// ── Import router after mocks ──────────────────────────────────────────────

const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /conversations — Redis caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance = { get: mockGet, setex: mockSetex, del: mockDel };
    mockGroupBy.mockResolvedValue([]);
    mockExecute.mockResolvedValue([]);
  });

  it('returns cached data without hitting DB on cache hit', async () => {
    const cached = [{ id: 'conv-1', type: 'dm' }];
    mockGet.mockResolvedValue(JSON.stringify(cached));

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cached);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('queries DB and writes to cache on cache miss', async () => {
    mockGet.mockResolvedValue(null); // cache miss
    mockFindMany.mockResolvedValue([
      { conversationId: 'conv-2', conversation: { id: 'conv-2', type: 'group', messages: [] } },
    ]);
    mockSetex.mockResolvedValue('OK');

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalled();
    expect(mockSetex).toHaveBeenCalledWith(`conversations:${TEST_USER_ID}`, 30, expect.any(String));
  });

  it('falls back to DB when Redis is unavailable (redis is null)', async () => {
    mockRedisInstance = null; // simulate no Redis
    const dbResult = [{ id: 'conv-3' }];
    mockFindMany.mockResolvedValue(
      dbResult.map((c) => ({ conversationId: c.id, conversation: c })),
    );

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('falls back to DB when Redis.get throws', async () => {
    mockGet.mockRejectedValue(new Error('Redis connection refused'));
    const dbResult = [{ id: 'conv-4' }];
    mockFindMany.mockResolvedValue(
      dbResult.map((c) => ({ conversationId: c.id, conversation: c })),
    );
    mockSetex.mockResolvedValue('OK');

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalled();
  });

  it('uses per-user cache key (conversations:<userId>)', async () => {
    mockGet.mockResolvedValue(null);
    mockFindMany.mockResolvedValue([]);
    mockSetex.mockResolvedValue('OK');

    await request(makeApp()).get('/conversations');

    expect(mockGet).toHaveBeenCalledWith(`conversations:${TEST_USER_ID}`);
    expect(mockSetex).toHaveBeenCalledWith(
      `conversations:${TEST_USER_ID}`,
      expect.any(Number),
      expect.any(String),
    );
  });
});

describe('GET /conversations/:id/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 410 Gone for E2EE environments', async () => {
    const res = await request(makeApp()).get('/conversations/conv-1/search?q=hello');

    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      error: 'Server-side search removed; search is now client-side over decrypted messages',
      docs: 'https://github.com/DripWave/clicked/blob/main/docs/message-encryption-migration.md'
    });
  });
});

describe('GET /conversations — isArchived filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance = null; // bypass Redis for these tests
    mockGroupBy.mockResolvedValue([]);
    mockExecute.mockResolvedValue([]);
  });

  it('excludes archived conversations by default (no ?archived param)', async () => {
    const { ne } = await import('drizzle-orm');
    mockFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    // ne(isArchived, true) must appear in the where clause
    expect(ne).toHaveBeenCalledWith(
      expect.anything(), // conversationMembers.isArchived column
      true,
    );
  });

  it('excludes archived conversations when ?archived=false', async () => {
    const { ne } = await import('drizzle-orm');
    mockFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/conversations?archived=false');

    expect(res.status).toBe(200);
    expect(ne).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('includes archived conversations when ?archived=true', async () => {
    const { ne } = await import('drizzle-orm');
    mockFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/conversations?archived=true');

    expect(res.status).toBe(200);
    // ne should NOT be called — all conversations returned regardless of archived state
    expect(ne).not.toHaveBeenCalled();
  });

  it('skips cache read and write when ?archived=true', async () => {
    mockRedisInstance = { get: mockGet, setex: mockSetex, del: mockDel };
    mockFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/conversations?archived=true');

    expect(res.status).toBe(200);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSetex).not.toHaveBeenCalled();
  });
});
