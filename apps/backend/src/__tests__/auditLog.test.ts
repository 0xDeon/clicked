/**
 * #376 — audit logging for security-relevant events.
 *
 * Covers the two invariants that matter: every recorded event carries an
 * actor, device and timestamp, and no message content ever reaches a row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const insertedRows: Array<Record<string, unknown>> = [];
const mockValues = vi.fn(async (row: Record<string, unknown>) => {
  insertedRows.push(row);
});
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockAuditFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    insert: mockInsert,
    query: {
      auditLogs: { findMany: mockAuditFindMany },
    },
  },
}));

let currentAuth: { userId: string; deviceId: string } | undefined = {
  userId: 'user-alice',
  deviceId: 'device-alice',
};

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth?: typeof currentAuth }).auth = currentAuth;
    next();
  },
}));

const {
  recordAuditEvent,
  sanitizeMetadata,
  queryAuditLog,
  encodeAuditCursor,
  decodeAuditCursor,
  actorFromRequest,
} = await import('../services/auditLog.js');
const { auditLogsRouter } = await import('../routes/auditLogs.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/audit-logs', auditLogsRouter);
  return app;
}

/**
 * Every string reachable from a drizzle condition tree. The tree is cyclic
 * (columns point back at their table), so it cannot simply be stringified.
 */
function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => collectStrings(entry, seen));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  currentAuth = { userId: 'user-alice', deviceId: 'device-alice' };
  mockInsert.mockReturnValue({ values: mockValues });
});

// ─── recording ────────────────────────────────────────────────────────────────

describe('recordAuditEvent', () => {
  it('AC1 — records actor, device, subject and target for a security event', async () => {
    await recordAuditEvent({
      action: 'device_revoked',
      actorUserId: 'user-alice',
      actorDeviceId: 'device-alice',
      targetType: 'device',
      targetId: 'device-bob',
      ipAddress: '203.0.113.7',
      userAgent: 'clicked-web/1.0',
      metadata: { selfRevocation: false, remainingActiveDevices: 2 },
    });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      action: 'device_revoked',
      actorUserId: 'user-alice',
      actorDeviceId: 'device-alice',
      // Subject defaults to the actor when the event is about their own account.
      subjectUserId: 'user-alice',
      targetType: 'device',
      targetId: 'device-bob',
      ipAddress: '203.0.113.7',
      metadata: { selfRevocation: false, remainingActiveDevices: 2 },
    });
  });

  it('keeps the subject distinct when the event was done to someone else', async () => {
    await recordAuditEvent({
      action: 'key_bundle_drained',
      actorUserId: 'user-mallory',
      actorDeviceId: 'device-mallory',
      subjectUserId: 'user-alice',
      targetType: 'device',
      targetId: 'device-alice',
    });

    expect(insertedRows[0]).toMatchObject({
      actorUserId: 'user-mallory',
      subjectUserId: 'user-alice',
    });
  });

  it('records an unauthenticated failure with a null actor', async () => {
    await recordAuditEvent({
      action: 'auth_failed',
      targetType: 'wallet',
      targetId: 'GABC',
      metadata: { reason: 'signature_verification_failed' },
    });

    expect(insertedRows[0]).toMatchObject({
      action: 'auth_failed',
      actorUserId: null,
      actorDeviceId: null,
      subjectUserId: null,
    });
  });

  it('never lets a failed audit write break the action it observes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInsert.mockImplementation(() => {
      throw new Error('audit table unavailable');
    });

    await expect(
      recordAuditEvent({ action: 'device_revoked', actorUserId: 'user-alice' }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });

  it('derives actor and request context from an authenticated request', async () => {
    const captured: Array<ReturnType<typeof actorFromRequest>> = [];
    const app = express();
    app.get('/probe', (req, res) => {
      (req as express.Request & { auth?: typeof currentAuth }).auth = currentAuth;
      captured.push(actorFromRequest(req));
      res.json({ ok: true });
    });

    await request(app).get('/probe').set('User-Agent', 'clicked-web/2.0');

    expect(captured[0]).toMatchObject({
      actorUserId: 'user-alice',
      actorDeviceId: 'device-alice',
      userAgent: 'clicked-web/2.0',
    });
    expect(captured[0]?.ipAddress).toBeTruthy();
  });
});

// ─── redaction ────────────────────────────────────────────────────────────────

describe('AC2 — no message content reaches the log', () => {
  it('redacts content-shaped keys however they are spelled', () => {
    const sanitized = sanitizeMetadata({
      ciphertext: 'AAECAwQ=',
      cipherText: 'AAECAwQ=',
      content: 'hello there',
      messageBody: 'hello there',
      plaintext: 'hello there',
      envelope_ciphertext: 'AAECAwQ=',
      token: 'ey.jwt.value',
      preKey: 'secret-key-material',
      conversationId: 'conv-1',
      memberCount: 4,
    });

    expect(sanitized).toEqual({
      ciphertext: '[redacted]',
      cipherText: '[redacted]',
      content: '[redacted]',
      messageBody: '[redacted]',
      plaintext: '[redacted]',
      envelope_ciphertext: '[redacted]',
      token: '[redacted]',
      preKey: '[redacted]',
      conversationId: 'conv-1',
      memberCount: 4,
    });
  });

  it('redacts content nested one level down as well', () => {
    const sanitized = sanitizeMetadata({
      message: { ciphertext: 'AAECAwQ=' },
      device: { id: 'device-1', ciphertext: 'AAECAwQ=' },
    });

    expect(sanitized).toEqual({
      message: '[redacted]',
      device: { id: 'device-1', ciphertext: '[redacted]' },
    });
  });

  it('bounds strings, arrays, key counts and nesting depth', () => {
    const sanitized = sanitizeMetadata({
      long: 'x'.repeat(1000),
      list: Array.from({ length: 100 }, (_, i) => i),
      deep: { level2: { level3: { smuggled: 'x'.repeat(1000) } } },
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
    });

    expect((sanitized?.['long'] as string).length).toBeLessThanOrEqual(257);
    expect(sanitized?.['list']).toHaveLength(20);
    expect(sanitized?.['deep']).toEqual({ level2: '[object]' });
    expect(Object.keys(sanitized ?? {}).length).toBeLessThanOrEqual(20);
  });

  it('drops values an incident responder cannot use, and empty metadata', () => {
    expect(sanitizeMetadata({ fn: () => undefined, missing: undefined, kept: 1 })).toEqual({
      kept: 1,
    });
    expect(sanitizeMetadata(undefined)).toBeNull();
    expect(sanitizeMetadata({})).toBeNull();
  });

  it('sanitizes on the write path, not just when called directly', async () => {
    await recordAuditEvent({
      action: 'file_access_denied',
      actorUserId: 'user-mallory',
      metadata: { ciphertext: 'AAECAwQ=', reason: 'not_a_member' },
    });

    expect(insertedRows[0]?.['metadata']).toEqual({
      ciphertext: '[redacted]',
      reason: 'not_a_member',
    });
  });
});

// ─── querying ─────────────────────────────────────────────────────────────────

describe('AC3 — logs are queryable for an account', () => {
  const rows = [
    {
      id: 'evt-2',
      action: 'device_revoked',
      actorUserId: 'user-alice',
      actorDeviceId: 'device-alice',
      subjectUserId: 'user-alice',
      targetType: 'device',
      targetId: 'device-old',
      ipAddress: '203.0.113.7',
      userAgent: 'clicked-web/1.0',
      metadata: { selfRevocation: false },
      createdAt: new Date('2026-07-02T10:00:00Z'),
    },
    {
      id: 'evt-1',
      action: 'key_bundle_drained',
      actorUserId: 'user-mallory',
      actorDeviceId: 'device-mallory',
      subjectUserId: 'user-alice',
      targetType: 'device',
      targetId: 'device-alice',
      ipAddress: '198.51.100.4',
      userAgent: null,
      metadata: { oneTimePreKeysRemaining: 0, exhausted: true },
      createdAt: new Date('2026-07-01T10:00:00Z'),
    },
  ];

  it('returns the account history newest first, with a page cursor', async () => {
    mockAuditFindMany.mockResolvedValue(rows);

    const result = await queryAuditLog({ userId: 'user-alice', limit: 10 });

    expect(result.events).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(mockAuditFindMany).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
  });

  it('reports another page when one more row than the limit came back', async () => {
    mockAuditFindMany.mockResolvedValue(rows);

    const result = await queryAuditLog({ userId: 'user-alice', limit: 1 });

    expect(result.events).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(encodeAuditCursor(rows[0]!));
  });

  it('round-trips a cursor, tie-breaking on id within a millisecond', () => {
    const cursor = encodeAuditCursor(rows[0]!);
    expect(decodeAuditCursor(cursor)).toEqual({
      createdAt: rows[0]!.createdAt,
      id: 'evt-2',
    });
    expect(decodeAuditCursor('garbage')).toBeNull();
  });

  it('serves the caller their own history, marking what was done to them', async () => {
    mockAuditFindMany.mockResolvedValue(rows);

    const res = await request(makeApp()).get('/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toMatchObject({
      id: 'evt-2',
      action: 'device_revoked',
      direction: 'performed',
    });
    // Mallory drained Alice's bundle — Alice's own log must show it.
    expect(res.body.events[1]).toMatchObject({
      id: 'evt-1',
      action: 'key_bundle_drained',
      actorUserId: 'user-mallory',
      direction: 'received',
    });
  });

  it('has no parameter for reading someone else’s log', async () => {
    mockAuditFindMany.mockResolvedValue([]);

    await request(makeApp()).get('/audit-logs?userId=user-bob&subjectUserId=user-bob');

    // Whatever the query string claims, the scope is the authenticated caller.
    expect(mockAuditFindMany).toHaveBeenCalledTimes(1);
    const call = mockAuditFindMany.mock.calls[0]![0] as { where: unknown };
    const bound = collectStrings(call.where);
    expect(bound).toContain('user-alice');
    expect(bound).not.toContain('user-bob');
  });

  it('rejects an unknown action filter instead of silently ignoring it', async () => {
    const res = await request(makeApp()).get('/audit-logs?action=not_an_action');

    expect(res.status).toBe(400);
    expect(mockAuditFindMany).not.toHaveBeenCalled();
  });

  it('accepts a known action filter', async () => {
    mockAuditFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/audit-logs?action=auth_failed');

    expect(res.status).toBe(200);
    expect(mockAuditFindMany).toHaveBeenCalledTimes(1);
  });

  it('clamps the page size so one request cannot drain the table', async () => {
    mockAuditFindMany.mockResolvedValue([]);

    await request(makeApp()).get('/audit-logs?limit=100000');

    expect(mockAuditFindMany).toHaveBeenCalledWith(expect.objectContaining({ limit: 201 }));
  });
});
