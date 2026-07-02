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
      userDevices: { findFirst: mockFindDevice },
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
    sequenceNumber: 'sequence_number',
    conversationId: 'conversation_id',
    deletedAt: 'deleted_at',
  },
  userDevices: {
    id: 'id',
    userId: 'user_id',
    revokedAt: 'revoked_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  gt: vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: 'lt', col, val })),
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

function makeEnvelopeRow(seq: number, deliveredAt: Date | null = null) {
  return {
    id: `env-${seq}`,
    messageId: `msg-${seq}`,
    ciphertext: `cipher-${seq}`,
    deliveredAt,
    createdAt: new Date('2024-01-01'),
    sequenceNumber: seq,
    conversationId: 'conv-1',
  };
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

  it('returns 400 when sinceSequence is negative', async () => {
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=-1');
    expect(res.status).toBe(400);
  });

  it('returns 403 when device not owned by user', async () => {
    mockFindDevice.mockResolvedValue(null);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1');
    expect(res.status).toBe(403);
  });

  it('returns empty array when queue is empty', async () => {
    mockDbQuery([]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=0');
    expect(res.status).toBe(200);
    expect(res.body.envelopes).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe(0);
  });

  it('returns envelopes ordered by sequenceNumber', async () => {
    mockDbQuery([makeEnvelopeRow(1), makeEnvelopeRow(2), makeEnvelopeRow(3)]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=0');
    expect(res.status).toBe(200);
    const seqs = res.body.envelopes.map((e: { sequenceNumber: number }) => e.sequenceNumber);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('returns nextCursor equal to last sequenceNumber', async () => {
    mockDbQuery([makeEnvelopeRow(5), makeEnvelopeRow(7)]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=4');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe(7);
  });

  it('sets hasMore true when more pages exist', async () => {
    // Default page size is 50; return 51 rows to trigger hasMore
    const rows = Array.from({ length: 51 }, (_, i) => makeEnvelopeRow(i + 1));
    mockDbQuery(rows);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=0');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.envelopes).toHaveLength(50); // page size
  });

  it('respects sinceSequence cursor for partial sync', async () => {
    mockDbQuery([makeEnvelopeRow(11), makeEnvelopeRow(12)]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=10');
    expect(res.status).toBe(200);
    expect(res.body.envelopes.every((e: { sequenceNumber: number }) => e.sequenceNumber > 10)).toBe(
      true,
    );
  });

  it('includes already-delivered envelopes when cursor requests them', async () => {
    const delivered = makeEnvelopeRow(3, new Date());
    mockDbQuery([delivered]);
    const res = await request(makeApp()).get('/sync?deviceId=e2e-device-1&sinceSequence=2');
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
    expect(env).toHaveProperty('sequenceNumber');
  });
});
