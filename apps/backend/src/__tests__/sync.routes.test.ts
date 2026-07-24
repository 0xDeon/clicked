import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindDevice = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockFindDevice },
    },
    select: mockSelect,
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  messageEnvelopes: {
    id: 'id',
    messageId: 'message_id',
    recipientDeviceId: 'recipient_device_id',
    ciphertext: 'ciphertext',
    deliveredAt: 'delivered_at',
    createdAt: 'created_at',
  },
  messages: {
    id: 'id',
    conversationId: 'conversation_id',
    deletedAt: 'deleted_at',
  },
  devices: {
    id: 'id',
    userId: 'user_id',
    revokedAt: 'revoked_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((col: unknown) => ({ type: 'asc', col })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  gt: vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'auth-device-1',
    };
    next();
  },
}));

const { syncRouter } = await import('../routes/sync.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/sync', syncRouter);
  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// `n` drives both the id and the envelope's createdAt offset, so ordering by
// (createdAt, id) matches ordering by `n` — a stand-in for the old sequenceNumber.
function makeEnvelopeRow(n: number, deliveredAt: Date | null = null) {
  return {
    id: `env-${String(n).padStart(4, '0')}`,
    messageId: `msg-${n}`,
    ciphertext: `cipher-${n}`,
    deliveredAt,
    envelopeCreatedAt: new Date(2024, 0, 1, 0, 0, n),
    conversationId: 'conv-1',
    senderId: 'user-2',
    senderDeviceId: 'device-2',
    contentType: 'text/plain',
    messageCreatedAt: new Date(2024, 0, 1, 0, 0, n),
  };
}

function encodeCursor(n: number): string {
  const row = makeEnvelopeRow(n);
  return `${row.envelopeCreatedAt.getTime()}:${row.id}`;
}

function mockDbQuery(rows: ReturnType<typeof makeEnvelopeRow>[]) {
  // Chain: db.select().from().innerJoin().where().orderBy().limit()
  const limitFn = vi.fn().mockResolvedValue(rows);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
  mockSelect.mockReturnValue({ from: fromFn });
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  });
  return { limitFn, orderByFn, whereFn };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDevice.mockResolvedValue({ id: 'e2e-device-1', revokedAt: null });
});

describe('GET /sync', () => {
  it('returns 400 when deviceId is missing', async () => {
    const res = await request(makeApp()).get('/sync');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deviceId/);
  });

  it('returns 400 when cursor is malformed', async () => {
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('returns 403 when device not owned by user', async () => {
    mockFindDevice.mockResolvedValue(null);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(403);
  });

  it('returns empty array when queue is empty', async () => {
    mockDbQuery([]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(200);
    expect(res.body.envelopes).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns envelopes ordered by (createdAt, id)', async () => {
    mockDbQuery([makeEnvelopeRow(1), makeEnvelopeRow(2), makeEnvelopeRow(3)]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(200);
    const ids = res.body.envelopes.map((e: { id: string }) => e.id);
    expect(ids).toEqual(['env-0001', 'env-0002', 'env-0003']);
  });

  it('returns nextCursor encoding the last envelope returned', async () => {
    mockDbQuery([makeEnvelopeRow(5), makeEnvelopeRow(7)]);
    const res = await request(makeApp()).get(
      `/sync?deviceId=e2e-device-1&cursor=${encodeCursor(4)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe(encodeCursor(7));
  });

  it('sets hasMore true when more pages exist', async () => {
    // Default page size is 50; return 51 rows to trigger hasMore
    const rows = Array.from({ length: 51 }, (_, i) => makeEnvelopeRow(i + 1));
    mockDbQuery(rows);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.envelopes).toHaveLength(50); // page size
  });

  it('passes the decoded cursor through to the query filter', async () => {
    const { whereFn } = mockDbQuery([makeEnvelopeRow(11), makeEnvelopeRow(12)]);
    const res = await request(makeApp()).get(
      `/sync?deviceId=e2e-device-1&cursor=${encodeCursor(10)}`,
    );
    expect(res.status).toBe(200);
    expect(whereFn).toHaveBeenCalled();
  });

  it('includes already-delivered envelopes when within TTL', async () => {
    const delivered = makeEnvelopeRow(3, new Date());
    mockDbQuery([delivered]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(200);
    expect(res.body.envelopes).toHaveLength(1);
  });

  it('returns correct envelope shape', async () => {
    mockDbQuery([makeEnvelopeRow(1)]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(200);
    const env = res.body.envelopes[0];
    expect(env).toHaveProperty('id');
    expect(env).toHaveProperty('messageId');
    expect(env).toHaveProperty('conversationId');
    expect(env).toHaveProperty('ciphertext');
    expect(env).toHaveProperty('createdAt');
    expect(env).not.toHaveProperty('sequenceNumber');
  });
});
