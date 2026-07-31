/**
 * Tests for GET /conversations/:id/messages (#336).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockSelect = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst },
    },
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    senderId: 'senderId',
    senderDeviceId: 'senderDeviceId',
    contentType: 'contentType',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
    editsMessageId: 'editsMessageId',
    fileId: 'fileId',
  },
  messageEnvelopes: {
    messageId: 'messageId',
    ciphertext: 'ciphertext',
    recipientDeviceId: 'recipientDeviceId',
  },
  conversationMembers: {
    userId: 'userId',
    conversationId: 'conversationId',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((col: unknown) => ({ type: 'asc', col })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: 'lt', col, val })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'device-1',
    };
    next();
  },
}));

const { messagesRouter } = await import('../routes/messages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(messagesRouter);
  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessageRow(n: number, withEnvelope = true) {
  return {
    id: `msg-${String(n).padStart(3, '0')}`,
    conversationId: 'conv-1',
    senderId: 'user-2',
    senderDeviceId: 'device-2',
    contentType: 'text',
    createdAt: new Date(2024, 0, 1, 0, 0, n),
    deletedAt: null,
    editsMessageId: null,
    fileId: null,
    ciphertext: withEnvelope ? `cipher-${n}` : null,
  };
}

function mockDbQuery(rows: ReturnType<typeof makeMessageRow>[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
  mockSelect.mockReturnValue({ from: fromFn });
  return { limitFn, orderByFn, whereFn, leftJoinFn };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ id: 'cm-1' });
});

describe('GET /conversations/:id/messages (#336)', () => {
  it('returns 403 when caller is not a member', async () => {
    mockMemberFindFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/conversations/conv-1');
    expect(res.status).toBe(403);
  });

  it('returns empty array for a new conversation', async () => {
    mockDbQuery([]);
    const res = await request(makeApp()).get('/conversations/conv-1');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.cursor).toBeNull();
  });

  it('returns messages in ascending chronological order', async () => {
    mockDbQuery([makeMessageRow(3), makeMessageRow(2), makeMessageRow(1)]);
    const res = await request(makeApp()).get('/conversations/conv-1');
    expect(res.status).toBe(200);
    const ids = res.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['msg-001', 'msg-002', 'msg-003']);
  });

  it('sets hasMore true when more pages exist', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => makeMessageRow(i + 1));
    mockDbQuery(rows);
    const res = await request(makeApp()).get('/conversations/conv-1');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.messages).toHaveLength(50);
  });

  it('returns a cursor pointing to the oldest message in the set', async () => {
    mockDbQuery([makeMessageRow(10), makeMessageRow(9)]);
    const res = await request(makeApp()).get('/conversations/conv-1?before=msg-011');
    expect(res.status).toBe(200);
    expect(res.body.cursor).toBe('msg-009');
  });

  it('marks messages with no envelope for this device as unavailable', async () => {
    mockDbQuery([makeMessageRow(1, true), makeMessageRow(2, false)]);
    const res = await request(makeApp()).get('/conversations/conv-1');
    expect(res.status).toBe(200);
    const msg1 = res.body.messages.find((m: { id: string }) => m.id === 'msg-001');
    const msg2 = res.body.messages.find((m: { id:string }) => m.id === 'msg-002');
    expect(msg1.unavailable).toBeUndefined();
    expect(msg2.unavailable).toBe(true);
    expect(msg2.ciphertext).toBeNull();
  });
});