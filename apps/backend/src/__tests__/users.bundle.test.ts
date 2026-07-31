/**
 * Tests for GET /users/:userId/devices/:deviceId/key-bundle (#110).
 *
 * Moved here from GET /devices/:id/bundle so the URL matches the issue's
 * spec and so a caller can't fetch a bundle without already knowing which
 * user owns the device (`:userId` must match `device.userId` or the route
 * 404s, same as an unknown device).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockPrekeyFindFirst = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst },
      devicePrekeys: { findFirst: mockPrekeyFindFirst },
      users: { findFirst: vi.fn() },
      wallets: { findFirst: vi.fn() },
    },
    transaction: mockTransaction,
    update: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  users: {},
  wallets: {},
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: {
    id: 'id',
    deviceId: 'deviceId',
    keyType: 'keyType',
    keyId: 'keyId',
    publicKey: 'publicKey',
    consumed: 'consumed',
    createdAt: 'createdAt',
  },
  conversationMembers: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  or: vi.fn((...args: unknown[]) => args),
  ilike: vi.fn(),
  exists: vi.fn(),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  count: vi.fn(() => 'count(*)'),
  sql: vi.fn(),
}));

const mockSignalPrekeysLow = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/prekeyLowSignal.js', () => ({
  signalPrekeysLowIfNeeded: mockSignalPrekeysLow,
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../services/presence.js', () => ({ isOnline: vi.fn().mockResolvedValue(false) }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'caller-id' };
    next();
  },
}));

const { usersRouter } = await import('../routes/users.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  return app;
}

const OWNER_ID = 'owner-user-id';
const DEVICE = {
  id: 'device-2',
  userId: OWNER_ID,
  identityPublicKey: 'identity-key',
  registrationId: 42,
  revokedAt: null,
};

const SIGNED_PRE_KEY = { keyId: 1, publicKey: 'spk-pub', signature: 'spk-sig' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /users/:userId/devices/:deviceId/key-bundle', () => {
  it('returns 404 when device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/nonexistent/key-bundle`);

    expect(res.status).toBe(404);
  });

  it('returns 404 when :userId does not match the device owner', async () => {
    mockDeviceFindFirst.mockResolvedValue(DEVICE);

    const res = await request(makeApp()).get(`/users/someone-else/devices/device-2/key-bundle`);

    expect(res.status).toBe(404);
  });

  it('returns 404 when device is revoked', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...DEVICE, revokedAt: new Date() });

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`);

    expect(res.status).toBe(404);
  });

  it('returns 409 when device has no signed prekey', async () => {
    mockDeviceFindFirst.mockResolvedValue(DEVICE);
    mockPrekeyFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`);

    expect(res.status).toBe(409);
  });

  it('returns a full bundle and consumes one OTP atomically', async () => {
    mockDeviceFindFirst.mockResolvedValue(DEVICE);
    mockPrekeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);

    const claimed = { id: 'otp-row-1', keyId: 10, publicKey: 'otp-pub' };
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const lockFor = vi.fn().mockResolvedValue([claimed]);
    const tx = {
      // Two selects run inside the claiming transaction: the row-locked claim,
      // then the post-consumption remaining count that drives `prekeys_low`.
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  for: lockFor,
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 4 }]),
          }),
        }),
      update: vi.fn().mockReturnValue({ set: updateSet }),
    };
    mockTransaction.mockImplementation(async (cb: (txArg: typeof tx) => unknown) => cb(tx));

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`);

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe('device-2');
    expect(res.body.identityPublicKey).toBe('identity-key');
    expect(res.body.registrationId).toBe(42);
    expect(res.body.signedPreKey).toEqual(SIGNED_PRE_KEY);
    expect(res.body.oneTimePreKey).toEqual({ keyId: 10, publicKey: 'otp-pub' });
    // Claim runs inside a transaction, and the candidate row is row-locked with
    // SKIP LOCKED so concurrent bundle fetches take different rows instead of
    // handing the same prekey out twice.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(lockFor).toHaveBeenCalledWith('update', { skipLocked: true });
    // consumed flipped to true — the row is never deleted, so bundle-fetch
    // history stays auditable.
    expect(updateSet).toHaveBeenCalledWith({ consumed: true });
    expect(updateWhere).toHaveBeenCalled();
    // The post-consumption count feeds the low-prekey signal, which decides on
    // its own whether this crossed the threshold.
    expect(mockSignalPrekeysLow).toHaveBeenCalledWith('device-2', 4);
  });

  it('uses skipLocked so concurrent bundle reads only consume one OTP', async () => {
    mockDeviceFindFirst.mockResolvedValue(DEVICE);
    mockPrekeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);

    const claimed = { id: 'otp-row-1', keyId: 10, publicKey: 'otp-pub' };
    let locked = false;
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockImplementation(async (_mode: string, options: { skipLocked?: boolean }) => {
                  expect(_mode).toBe('update');
                  expect(options).toEqual({ skipLocked: true });
                  if (locked) return [];
                  locked = true;
                  return [claimed];
                }),
              }),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) }),
    };
    mockTransaction.mockImplementation(async (cb: (txArg: typeof tx) => unknown) => cb(tx));

    const [firstRes, secondRes] = await Promise.all([
      request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`),
      request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect([firstRes.body.oneTimePreKey, secondRes.body.oneTimePreKey].filter(Boolean)).toHaveLength(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('falls back to signed-prekey-only when OTPs are exhausted', async () => {
    mockDeviceFindFirst.mockResolvedValue(DEVICE);
    mockPrekeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);

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
      update: vi.fn(),
    };
    mockTransaction.mockImplementation(async (cb: (txArg: typeof tx) => unknown) => cb(tx));

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`);

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKey).toBeNull();
    expect(tx.update).not.toHaveBeenCalled();
    // Nothing was consumed, so the count did not move — the crossing already
    // signalled on the fetch that drained the last key.
    expect(mockSignalPrekeysLow).not.toHaveBeenCalled();
  });
});
