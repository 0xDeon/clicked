/**
 * Tests for GET /devices/:id/bundle, DELETE /devices/:id,
 * and POST /devices/logout-everywhere (issues #305, #302).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockSignedPreKeyFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst },
      signedPreKeys: { findFirst: mockSignedPreKeyFindFirst },
    },
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', isRevoked: 'isRevoked' },
  signedPreKeys: { deviceId: 'deviceId', keyId: 'keyId' },
  oneTimePreKeys: { id: 'id', deviceId: 'deviceId', keyId: 'keyId', createdAt: 'createdAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  ne: vi.fn((col: unknown, val: unknown) => ({ op: 'ne', col, val })),
  count: vi.fn(() => 'count(*)'),
  desc: vi.fn((col: unknown) => ({ op: 'desc', col })),
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
  userId: 'other-user-id',
  identityPublicKey: 'identity-key',
  registrationId: 42,
  isRevoked: false,
};

const SIGNED_PRE_KEY = {
  keyId: 1,
  publicKey: 'spk-pub',
  signature: 'spk-sig',
};

function setupUpdateChain(returningRows: unknown[] = []) {
  // `.where(...)` is awaitable directly (DELETE /:id) and also chains
  // `.returning(...)` (POST /logout-everywhere) — mirror both shapes.
  const returning = vi.fn().mockResolvedValue(returningRows);
  const whereResult = Object.assign(Promise.resolve(undefined), { returning });
  const where = vi.fn().mockReturnValue(whereResult);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where, returning };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentAuth = { userId: 'owner-user-id', deviceId: 'device-1' };
});

describe('GET /devices/:id/bundle', () => {
  it('returns 404 when device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/devices/nonexistent/bundle');

    expect(res.status).toBe(404);
  });

  it('returns 404 when device is revoked', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, isRevoked: true });

    const res = await request(makeApp()).get('/devices/device-2/bundle');

    expect(res.status).toBe(404);
  });

  it('returns 409 when device has no signed prekey', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    mockSignedPreKeyFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/devices/device-2/bundle');

    expect(res.status).toBe(409);
  });

  it('returns a full bundle and consumes one OTP atomically', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    mockSignedPreKeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);

    const claimed = { id: 'otp-1', keyId: 10, publicKey: 'otp-pub' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([claimed]),
              }),
            }),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: deleteWhere }),
    };
    mockTransaction.mockImplementation(async (cb: (tx: typeof tx) => unknown) => cb(tx));

    const res = await request(makeApp()).get('/devices/device-2/bundle');

    expect(res.status).toBe(200);
    expect(res.body.identityPublicKey).toBe('identity-key');
    expect(res.body.registrationId).toBe(42);
    expect(res.body.signedPreKey).toEqual(SIGNED_PRE_KEY);
    expect(res.body.oneTimePreKey).toEqual({ keyId: 10, publicKey: 'otp-pub' });
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('falls back to signed-prekey-only when OTPs are exhausted', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    mockSignedPreKeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);

    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
      delete: vi.fn(),
    };
    mockTransaction.mockImplementation(async (cb: (tx: typeof tx) => unknown) => cb(tx));

    const res = await request(makeApp()).get('/devices/device-2/bundle');

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKey).toBeNull();
    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE /devices/:id', () => {
  it('returns 404 when revoking a device owned by another user', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'someone-else' });

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(404);
  });

  it('revokes an owned device', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'owner-user-id' });
    setupUpdateChain();

    const res = await request(makeApp()).delete('/devices/device-2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'device-2', isRevoked: true });
  });
});

describe('POST /devices/logout-everywhere', () => {
  it('revokes all other devices and reports the count', async () => {
    setupUpdateChain([{ id: 'device-2' }, { id: 'device-3' }]);

    const res = await request(makeApp()).post('/devices/logout-everywhere');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedCount: 2 });
  });
});
