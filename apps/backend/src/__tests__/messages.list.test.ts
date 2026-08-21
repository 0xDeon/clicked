/**
 * Tests for GET /conversations/:id/messages (#336).
 *
 * The endpoint pages backwards over a conversation with a `(createdAt, id)`
 * cursor, collapses edit chains to their newest version, and runs every row
 * through `serializeMessage` so the shape matches `GET /conversations/:id`
 * and a message this device holds no envelope for is explicitly marked
 * `unavailable` rather than arriving as an unexplained null ciphertext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockMessageFindMany = vi.fn();
const mockSelect = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst },
      messages: { findFirst: mockMessageFindFirst, findMany: mockMessageFindMany },
    },
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    createdAt: 'createdAt',
    editsMessageId: 'editsMessageId',
  },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  conversationMembers: { userId: 'userId', conversationId: 'conversationId' },
  conversations: {},
  tokenTransfers: {},
  devices: {},
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((col: unknown) => ({ type: 'asc', col })),
  count: vi.fn(() => ({ type: 'count' })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })),
  isNotNull: vi.fn((col: unknown) => ({ type: 'isNotNull', col })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: 'lt', col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ type: 'ne', col, val })),
  notInArray: vi.fn((col: unknown, vals: unknown) => ({ type: 'notInArray', col, vals })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals })),
    { raw: vi.fn() },
  ),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

vi.mock('../lib/socket.js', () => ({ getSocketServer: () => null }));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

// Non-MLS conversation: the epoch-window lookup finds no group, so every row
// stays visible and the MLS placeholder path is not exercised here.
vi.mock('../services/mlsGroups.js', () => ({
  getConversationEpochWindow: vi.fn().mockResolvedValue({ hasGroup: false, window: null }),
}));

vi.mock('../services/groupControl.js', () => ({
  appendGroupControlEvent: vi.fn(),
  broadcastGroupControlEvent: vi.fn(),
  getGroupState: vi.fn(),
  readGroupControlEvents: vi.fn(),
  serializeGroupControlEvent: (e: unknown) => e,
  DEFAULT_GROUP_CONTROL_PAGE_SIZE: 100,
  MAX_GROUP_CONTROL_PAGE_SIZE: 500,
  MAX_GROUP_CONTROL_PAYLOAD_BYTES: 65536,
}));

vi.mock('../services/rateLimit.js', () => ({
  checkFirstContactLimit: vi.fn().mockResolvedValue({ allowed: true, count: 0 }),
  checkGroupInviteLimit: vi.fn().mockResolvedValue({ allowed: true, count: 0 }),
}));

vi.mock('../services/auditLog.js', () => ({
  actorFromRequest: vi.fn(() => ({})),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
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
    ciphertext: null,
    envelopes: withEnvelope ? [{ ciphertext: `cipher-${n}` }] : [],
  };
}

/** `db.select(...).from(...).where(...)` — the superseded-edit-ids lookup. */
function mockSupersededIds(ids: Array<{ id: string | null }>) {
  const whereFn = vi.fn().mockResolvedValue(ids);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockSelect.mockReturnValue({ from: fromFn });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ id: 'cm-1' });
  mockMessageFindMany.mockResolvedValue([]);
  mockSupersededIds([]);
});

describe('GET /conversations/:id/messages (#336)', () => {
  it('returns 403 when caller is not a member', async () => {
    mockMemberFindFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(403);
  });

  it('returns an empty array for a new conversation', async () => {
    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns messages in ascending chronological order', async () => {
    // The query fetches newest-first; the handler reverses for the response.
    mockMessageFindMany.mockResolvedValue([
      makeMessageRow(3),
      makeMessageRow(2),
      makeMessageRow(1),
    ]);
    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual([
      'msg-001',
      'msg-002',
      'msg-003',
    ]);
  });

  it('caps the page at the requested limit and reports a next cursor', async () => {
    // One extra row over the limit is what tells the handler more remain.
    const rows = Array.from({ length: 51 }, (_, i) => makeMessageRow(51 - i));
    mockMessageFindMany.mockResolvedValue(rows);

    const res = await request(makeApp()).get('/conversations/conv-1/messages?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(50);
    // Cursor points at the oldest message returned, to page further back.
    expect(res.body.nextCursor).toBe(res.body.messages[0].id);
  });

  it('returns a null cursor when the last page is reached', async () => {
    mockMessageFindMany.mockResolvedValue([makeMessageRow(2), makeMessageRow(1)]);
    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
  });

  it('rejects a cursor that does not resolve to a message', async () => {
    mockMessageFindFirst.mockResolvedValue(undefined);
    const res = await request(makeApp()).get('/conversations/conv-1/messages?before=nope');
    expect(res.status).toBe(400);
  });

  it('marks messages with no envelope for this device as unavailable', async () => {
    mockMessageFindMany.mockResolvedValue([makeMessageRow(2, false), makeMessageRow(1, true)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(200);

    const withEnvelope = res.body.messages.find((m: { id: string }) => m.id === 'msg-001');
    const withoutEnvelope = res.body.messages.find((m: { id: string }) => m.id === 'msg-002');

    expect(withEnvelope.unavailable).toBeUndefined();
    expect(withEnvelope.ciphertext).toBe('cipher-1');
    expect(withoutEnvelope.unavailable).toBe(true);
    expect(withoutEnvelope.ciphertext).toBeNull();
  });

  it('never leaks the raw envelopes relation into the response', async () => {
    mockMessageFindMany.mockResolvedValue([makeMessageRow(1)]);
    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.body.messages[0]).not.toHaveProperty('envelopes');
    expect(res.body.messages[0]).not.toHaveProperty('deletedAt');
  });

  it('excludes superseded versions so an edit chain collapses to its newest row', async () => {
    mockSupersededIds([{ id: 'msg-001' }]);
    mockMessageFindMany.mockResolvedValue([makeMessageRow(2)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');
    expect(res.status).toBe(200);

    // The superseded id is passed to the query as a NOT IN filter rather than
    // being filtered out after the fact.
    const { notInArray } = (await import('drizzle-orm')) as unknown as {
      notInArray: ReturnType<typeof vi.fn>;
    };
    expect(notInArray).toHaveBeenCalledWith(expect.anything(), ['msg-001']);
  });
});
