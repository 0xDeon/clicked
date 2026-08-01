/**
 * Tests for POST /devices/:id/prekeys (issue #159, updated for the unified
 * `device_prekeys` table — #104).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockOtpSelect = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst },
    },
    select: mockOtpSelect,
    insert: mockInsert,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId' },
  devicePrekeys: {
    deviceId: 'deviceId',
    keyType: 'keyType',
    keyId: 'keyId',
    consumed: 'consumed',
  },
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

// Real threshold + count logic, but the latch release is spied so we can assert
// the upload route re-arms the signal only once the device is back in range.
const mockReleaseLatch = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/prekeyLowSignal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/prekeyLowSignal.js')>()),
  releasePrekeysLowLatch: mockReleaseLatch,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  count: vi.fn(() => 'count(*)'),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    { raw: vi.fn() },
  ),
}));

// Stub crypto verify so we can control the outcome in tests.
// keys.ts uses the one-shot `verify` (not the streaming `createVerify`).
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    verify: vi.fn(() => true), // valid by default
  };
});

// Stub requireAuth: inject a fixed userId into req.auth.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'owner-user-id' };
    next();
  },
}));

const { devicesRouter } = await import('../routes/devices.js');
const { verify: cryptoVerify } = await import('node:crypto');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  return app;
}

const VALID_BODY = {
  signedPreKey: {
    keyId: 1,
    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32-byte base64 placeholder
    signature:
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', // 64-byte base64 placeholder
  },
  oneTimePreKeys: [
    { keyId: 10, publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    { keyId: 11, publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
  ],
};

const ACTIVE_DEVICE = {
  id: 'device-1',
  userId: 'owner-user-id',
  identityPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  revokedAt: null,
};

function setupInsertChain() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  mockInsert.mockReturnValue({ values });
  return { values, onConflictDoUpdate, onConflictDoNothing };
}

function setupOtpCount(total: number) {
  const where = vi.fn().mockResolvedValue([{ total }]);
  const from = vi.fn().mockReturnValue({ where });
  mockOtpSelect.mockReturnValue({ from });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /devices/:id/prekeys', () => {
  it('returns 404 when device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).post('/devices/nonexistent/prekeys').send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 403 when the caller is not the device owner', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'other-user' });

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('returns 403 when the device is revoked', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, revokedAt: new Date() });

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it('returns 400 when signed prekey signature is invalid', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    // Override the crypto mock to return false for this test.
    vi.mocked(cryptoVerify).mockReturnValueOnce(false as never);

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 422 when the OTP cap is reached', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(200); // at cap

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cap/i);
  });

  it('returns 400 when oneTimePreKeys array is empty', async () => {
    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({ ...VALID_BODY, oneTimePreKeys: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing signedPreKey', async () => {
    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({ oneTimePreKeys: VALID_BODY.oneTimePreKeys });

    expect(res.status).toBe(400);
  });

  it('uploads prekeys successfully and returns counts', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(0);
    setupInsertChain();

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.uploadedSignedPreKey).toBe(true);
    expect(res.body.uploadedOneTimePreKeys).toBe(2);
    expect(res.body.capped).toBe(false);
    expect(mockInsert).toHaveBeenCalledTimes(2); // signed + OTP
  });

  it('re-arms the low-prekey signal once replenished to the threshold', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(50); // post-upload recount lands at or above the threshold
    setupInsertChain();

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKeysRemaining).toBe(50);
    expect(mockReleaseLatch).toHaveBeenCalledWith('device-1');
  });

  it('leaves the signal armed when still below the threshold after upload', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(3);
    setupInsertChain();

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKeysRemaining).toBe(3);
    expect(mockReleaseLatch).not.toHaveBeenCalled();
  });

  it('trims the OTP batch to the remaining cap space', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(199); // 1 slot left
    setupInsertChain();

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_BODY); // sends 2 OTPs

    expect(res.status).toBe(200);
    expect(res.body.uploadedOneTimePreKeys).toBe(1); // capped at 1
    expect(res.body.capped).toBe(true);
  });

  // Replenishment threshold boundary (issue: Signal invariant assertions) —
  // the cap check must be an exact `<=` on remaining slots, not off-by-one
  // in either direction: a batch that exactly fits the remaining space must
  // upload in full and NOT be reported as capped.
  it('replenishes exactly up to the cap boundary without marking it capped', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupOtpCount(199); // exactly 1 slot left
    setupInsertChain();

    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({ ...VALID_BODY, oneTimePreKeys: [VALID_BODY.oneTimePreKeys[0]!] }); // sends exactly 1 OTP

    expect(res.status).toBe(200);
    expect(res.body.uploadedOneTimePreKeys).toBe(1);
    expect(res.body.capped).toBe(false);
  });
});
