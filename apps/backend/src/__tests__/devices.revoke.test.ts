/**
 * Tests for DELETE /devices/:id and POST /devices/logout-everywhere (#107, #119).
 *
 * Revocation now has real side effects (#107's fix): prekeys are deleted,
 * `device_revoked:*` is published so live sockets get force-disconnected
 * (#146), a key-change system event is emitted, and revoking a caller's
 * only active device is refused. The old GET /devices/:id/bundle endpoint
 * that used to live in this file moved to
 * GET /users/:userId/devices/:deviceId/key-bundle (#110) — see users.bundle.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockFindMany = vi.fn();
const mockSelect = vi.fn();
const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockMarkDeviceRevoked = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst, findMany: mockFindMany },
      conversationMembers: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: mockUpdate,
    delete: mockDelete,
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: { deviceId: 'deviceId' },
  wallets: { userId: 'userId', address: 'address', isPrimary: 'isPrimary' },
  conversationMembers: { userId: 'userId', conversationId: 'conversationId' },
  messages: {},
}));

vi.mock('../lib/redis.js', () => ({ redis: { publish: mockPublish } }));

vi.mock('../services/deviceRevocation.js', () => ({
  markDeviceRevoked: mockMarkDeviceRevoked,
}));

vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));

// #376 — revocation is a security event; assert it reaches the audit log.
const mockRecordAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/auditLog.js', () => ({
  recordAuditEvent: mockRecordAuditEvent,
  actorFromRequest: (req: { auth?: { userId: string; deviceId: string } }) => ({
    actorUserId: req.auth?.userId ?? null,
    actorDeviceId: req.auth?.deviceId ?? null,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  ne: vi.fn((col: unknown, val: unknown) => ({ op: 'ne', col, val })),
  count: vi.fn(() => 'count(*)'),
  desc: vi.fn((col: unknown) => ({ op: 'desc', col })),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  inArray: vi.fn((col: unknown, val: unknown) => ({ op: 'inArray', col, val })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    { raw: vi.fn() },
  ),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, verify: vi.fn(() => true) };
});

let currentAuth = { userId: 'owner-user-id', deviceId: 'device-1' };

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: typeof currentAuth }).auth = currentAuth;
    next();
  },
}));

const { devicesRouter } = await import('../routes/devices.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  return app;
}

const ACTIVE_DEVICE = {
  id: 'device-2',
  userId: 'owner-user-id',
  identityPublicKey: 'identity-key',
  registrationId: 42,
  revokedAt: null,
};

function setupUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

function setupDeleteChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  mockDelete.mockReturnValue({ where });
  return { where };
}

function setupActiveCount(total: number) {
  const where = vi.fn().mockResolvedValue([{ total }]);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentAuth = { userId: 'owner-user-id', deviceId: 'device-1' };
  setupUpdateChain();
  setupDeleteChain();
});

describe('DELETE /devices/:id', () => {
  it('returns 404 when the device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(404);
  });

  it('returns 404 when revoking a device owned by another user', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'someone-else' });

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(404);
  });

  it('is idempotent for an already-revoked device', async () => {
    const revokedAt = new Date('2026-01-01T00:00:00.000Z');
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, revokedAt });

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'device-2', revokedAt: revokedAt.toISOString() });
    // No side effects re-run for an already-revoked device.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("refuses to revoke the caller's only active device", async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupActiveCount(1);

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('revokes an owned device: clears prekeys, publishes device_revoked, marks it locally', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupActiveCount(2);

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('device-2');
    expect(res.body.revokedAt).toBeTruthy();
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(mockMarkDeviceRevoked).toHaveBeenCalledWith('device-2');
    expect(mockPublish).toHaveBeenCalledWith('device_revoked:device-2', '1');
  });

  it('records the revocation in the audit log with actor, device and context (#376)', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupActiveCount(2);

    await request(makeApp()).delete('/devices/device-2');

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'device_revoked',
        actorUserId: 'owner-user-id',
        actorDeviceId: 'device-1',
        targetType: 'device',
        targetId: 'device-2',
        metadata: expect.objectContaining({
          selfRevocation: false,
          remainingActiveDevices: 1,
        }),
      }),
    );
  });
});

describe('POST /devices/logout-everywhere', () => {
  it('revokes all other active devices and reports the count', async () => {
    mockFindMany.mockResolvedValue([{ id: 'device-2' }, { id: 'device-3' }]);

    const res = await request(makeApp()).post('/devices/logout-everywhere');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedCount: 2 });
    expect(mockMarkDeviceRevoked).toHaveBeenCalledWith('device-2');
    expect(mockMarkDeviceRevoked).toHaveBeenCalledWith('device-3');
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('reports zero when there are no other active devices', async () => {
    mockFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).post('/devices/logout-everywhere');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedCount: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('audits the account-wide action and each device it revoked (#376)', async () => {
    mockFindMany.mockResolvedValue([{ id: 'device-2' }, { id: 'device-3' }]);

    await request(makeApp()).post('/devices/logout-everywhere');

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout_everywhere',
        actorUserId: 'owner-user-id',
        metadata: expect.objectContaining({ revokedCount: 2, retainedDeviceId: 'device-1' }),
      }),
    );
    for (const id of ['device-2', 'device-3']) {
      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'device_revoked',
          targetId: id,
          metadata: { viaLogoutEverywhere: true },
        }),
      );
    }
  });

  it('audits the attempt even when there was nothing to revoke (#376)', async () => {
    mockFindMany.mockResolvedValue([]);

    await request(makeApp()).post('/devices/logout-everywhere');

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout_everywhere',
        metadata: expect.objectContaining({ revokedCount: 0 }),
      }),
    );
  });
});
