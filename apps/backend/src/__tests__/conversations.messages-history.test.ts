import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── mock schema (column refs are just their own string names, matching the
// convention already used in conversations.routes.test.ts) ────────────────
const messagesTable = {
  id: 'id',
  conversationId: 'conversationId',
  editsMessageId: 'editsMessageId',
  createdAt: 'createdAt',
  deletedAt: 'deletedAt',
};
const conversationMembersTable = { conversationId: 'conversationId', userId: 'userId' };
const messageEnvelopesTable = { recipientDeviceId: 'recipientDeviceId', messageId: 'messageId' };

// ── an in-memory fixture "table" the mocked query builders read from ───────
let fixtureMessages: Array<Record<string, unknown>> = [];

const mockFindMember = vi.fn();

vi.mock('../lib/socket.js', () => ({ getSocketServer: () => undefined }));
vi.mock('../lib/redis.js', () => ({ get redis() { return null; }, CONV_CACHE_TTL: 30, convCacheKey: () => '' }));
vi.mock('../lib/conversationCache.js', () => ({ invalidateConversationCaches: vi.fn() }));
vi.mock('../lib/messages.js', () => ({ serializeMessage: (m: unknown) => m }));

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: conversationMembersTable,
  messages: messagesTable,
  messageEnvelopes: messageEnvelopesTable,
  tokenTransfers: {},
  devices: {},
}));

// ── a tiny predicate-tree interpreter so the mocked `findMany`/`select`
// calls filter the fixture the same way Postgres would filter real rows,
// rather than just recording that a filter was requested. This is what
// lets these tests actually prove the edit-chain exclusion works, not just
// that the right drizzle helper was called. ────────────────────────────────
type Cond =
  | { type: 'eq'; col: string; val: unknown }
  | { type: 'lt'; col: string; val: unknown }
  | { type: 'isNotNull'; col: string }
  | { type: 'notInArray'; col: string; arr: unknown[] }
  | { type: 'and'; conds: Array<Cond | undefined> }
  | { type: 'or'; conds: Array<Cond | undefined> }
  | undefined;

function evalCond(row: Record<string, unknown>, cond: Cond): boolean {
  if (!cond) return true;
  switch (cond.type) {
    case 'eq':
      return row[cond.col] === cond.val;
    case 'lt':
      return (row[cond.col] as any) < (cond.val as any);
    case 'isNotNull':
      return row[cond.col] !== null && row[cond.col] !== undefined;
    case 'notInArray':
      return !cond.arr.includes(row[cond.col]);
    case 'and':
      return cond.conds.every((c) => evalCond(row, c));
    case 'or':
      return cond.conds.some((c) => evalCond(row, c));
  }
}

vi.mock('drizzle-orm', () => ({
  and: (...conds: Array<Cond | undefined>) => ({ type: 'and', conds }) satisfies Cond,
  or: (...conds: Array<Cond | undefined>) => ({ type: 'or', conds }) satisfies Cond,
  eq: (col: string, val: unknown) => ({ type: 'eq', col, val }) satisfies Cond,
  lt: (col: string, val: unknown) => ({ type: 'lt', col, val }) satisfies Cond,
  isNotNull: (col: string) => ({ type: 'isNotNull', col }) satisfies Cond,
  notInArray: (col: string, arr: unknown[]) => ({ type: 'notInArray', col, arr }) satisfies Cond,
  desc: (col: string) => ({ dir: 'desc', col }),
  asc: (col: string) => ({ dir: 'asc', col }),
  count: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
  ne: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindMember },
      messages: {
        findFirst: vi.fn(async ({ where }: { where: Cond }) =>
          fixtureMessages.find((row) => evalCond(row, where)),
        ),
        findMany: vi.fn(async ({ where, orderBy, limit }: { where: Cond; orderBy: unknown; limit: number }) => {
          let rows = fixtureMessages.filter((row) => evalCond(row, where));
          // orderBy is always [desc(createdAt), desc(id)] in this route.
          rows = [...rows].sort((a, b) => {
            const byCreatedAt = String(b['createdAt']).localeCompare(String(a['createdAt']));
            if (byCreatedAt !== 0) return byCreatedAt;
            return String(b['id']).localeCompare(String(a['id']));
          });
          void orderBy;
          return rows.slice(0, limit);
        }),
      },
    },
    select: (projection: { id: string }) => ({
      from: () => ({
        where: async (where: Cond) => {
          void projection;
          return fixtureMessages
            .filter((row) => evalCond(row, where))
            .map((row) => ({ id: row['editsMessageId'] ?? null }));
        },
      }),
    }),
  },
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

const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

function msg(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'm-default',
    conversationId: 'conv-1',
    senderId: 'user-1',
    editsMessageId: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    sender: { id: 'user-1', username: 'alice', avatarUrl: null },
    envelopes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtureMessages = [];
  mockFindMember.mockResolvedValue({ conversationId: 'conv-1', userId: 'user-1' });
});

describe('GET /conversations/:id/messages — edit-chain resolution (#340)', () => {
  it('returns a message with no edits unchanged', async () => {
    fixtureMessages = [msg({ id: 'm1', createdAt: '2026-01-01T00:00:00.000Z' })];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('resolves a single-edit chain to only the newest version', async () => {
    fixtureMessages = [
      msg({ id: 'm1-original', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'm1-edit', createdAt: '2026-01-01T00:05:00.000Z', editsMessageId: 'm1-original' }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['m1-edit']);
  });

  it('resolves a multi-hop edit chain (edit-of-an-edit) to just the tip', async () => {
    fixtureMessages = [
      msg({ id: 'v1', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'v2', createdAt: '2026-01-01T00:05:00.000Z', editsMessageId: 'v1' }),
      msg({ id: 'v3', createdAt: '2026-01-01T00:10:00.000Z', editsMessageId: 'v2' }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['v3']);
  });

  it('resolves independent edit chains and untouched messages together', async () => {
    fixtureMessages = [
      msg({ id: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'a2', createdAt: '2026-01-01T00:01:00.000Z', editsMessageId: 'a1' }),
      msg({ id: 'b1', createdAt: '2026-01-01T00:02:00.000Z' }), // never edited
      msg({ id: 'c1', createdAt: '2026-01-01T00:03:00.000Z' }),
      msg({ id: 'c2', createdAt: '2026-01-01T00:04:00.000Z', editsMessageId: 'c1' }),
      msg({ id: 'c3', createdAt: '2026-01-01T00:05:00.000Z', editsMessageId: 'c2' }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    const ids = res.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['a2', 'b1', 'c3']);
  });

  it('does not exclude anything when no message in the conversation has been edited', async () => {
    fixtureMessages = [
      msg({ id: 'm1', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'm2', createdAt: '2026-01-01T00:01:00.000Z' }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  });

  it('leaves tombstoned (deleted) messages visible exactly as before, independent of edit resolution', async () => {
    fixtureMessages = [
      msg({ id: 'm1', createdAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('scopes edit-chain resolution per conversation — an edit in another conversation does not affect this one', async () => {
    fixtureMessages = [
      msg({ id: 'm1', conversationId: 'conv-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      // Same id coincidentally referenced as an edit target, but in a different conversation.
      msg({ id: 'other-1', conversationId: 'conv-2', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({
        id: 'other-2',
        conversationId: 'conv-2',
        createdAt: '2026-01-01T00:01:00.000Z',
        editsMessageId: 'other-1',
      }),
    ];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('returns 403 for a non-member', async () => {
    mockFindMember.mockResolvedValue(undefined);
    fixtureMessages = [msg({ id: 'm1' })];

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(403);
  });
});
