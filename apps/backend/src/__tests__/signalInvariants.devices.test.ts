/**
 * Signal-invariant guards for the device/prekey endpoints.
 *
 * Locks in that the server never accepts Signal session/ratchet/private-key
 * state: `POST /devices` and `POST /devices/:id/prekeys` only ever carry
 * public identity and prekey material, and their schemas are `.strict()` —
 * any unrecognized field (top-level or nested inside signedPreKey /
 * oneTimePreKeys entries) must fail validation with 400 rather than being
 * silently stripped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

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
  devices: { id: 'id', userId: 'userId', identityPublicKey: 'identityPublicKey' },
  devicePrekeys: {
    deviceId: 'deviceId',
    keyType: 'keyType',
    keyId: 'keyId',
    consumed: 'consumed',
  },
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  count: vi.fn(() => 'count(*)'),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    { raw: vi.fn() },
  ),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    verify: vi.fn(() => true),
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'owner-user-id' };
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

// Byte-exact placeholders built the same way lib/keys.ts validates them,
// rather than fragile hand-rolled base64 literals.
const IDENTITY_KEY = Buffer.alloc(44, 1).toString('base64'); // ED25519_SPKI_BYTES
const RAW_KEY = Buffer.alloc(32, 2).toString('base64'); // ED25519_RAW_KEY_BYTES
const SIGNATURE = Buffer.alloc(64, 3).toString('base64'); // ED25519_SIG_BYTES

const VALID_DEVICE_BODY = {
  deviceName: 'Phone',
  platform: 'ios' as const,
  identityPublicKey: IDENTITY_KEY,
};

const VALID_PREKEYS_BODY = {
  signedPreKey: { keyId: 1, publicKey: RAW_KEY, signature: SIGNATURE },
  oneTimePreKeys: [{ keyId: 10, publicKey: RAW_KEY }],
};

const ACTIVE_DEVICE = {
  id: 'device-1',
  userId: 'owner-user-id',
  identityPublicKey: IDENTITY_KEY,
  revokedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Device registration moved behind a fresh-wallet-signature challenge (#233):
// POST /devices itself is now a hard 403 pointing at the link flow, so the
// payload invariant is enforced on POST /devices/link/verify, the route that
// actually creates the device row.
describe('POST /devices/link/verify — session/private-key state rejection', () => {
  const LINK_BODY = { ...VALID_DEVICE_BODY, signature: 'sig', nonce: 'nonce' };

  it('rejects an unrecognized top-level field with 400', async () => {
    const res = await request(makeApp())
      .post('/devices/link/verify')
      .send({ ...LINK_BODY, sessionState: 'opaque-session-blob' });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a private-key field with 400', async () => {
    const res = await request(makeApp())
      .post('/devices/link/verify')
      .send({ ...LINK_BODY, identityPrivateKey: 'should-never-leave-the-client' });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /devices — retired in favour of the link flow', () => {
  it('refuses to register a device without a fresh wallet signature', async () => {
    const res = await request(makeApp()).post('/devices').send(VALID_DEVICE_BODY);

    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /devices/:id/prekeys — session/private-key state rejection', () => {
  it('rejects an unrecognized top-level field with 400', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);

    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({ ...VALID_PREKEYS_BODY, ratchetState: { rootKey: 'x', chainKey: 'y' } });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a private key nested inside signedPreKey with 400', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);

    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({
        signedPreKey: { keyId: 1, publicKey: RAW_KEY, signature: SIGNATURE, privateKey: RAW_KEY },
        oneTimePreKeys: VALID_PREKEYS_BODY.oneTimePreKeys,
      });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a private key nested inside a one-time prekey entry with 400', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);

    const res = await request(makeApp())
      .post('/devices/device-1/prekeys')
      .send({
        signedPreKey: VALID_PREKEYS_BODY.signedPreKey,
        oneTimePreKeys: [{ keyId: 10, publicKey: RAW_KEY, privateKey: RAW_KEY }],
      });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('still accepts a well-formed body with no extra fields (control case)', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    const where = vi.fn().mockResolvedValue([{ total: 0 }]);
    const from = vi.fn().mockReturnValue({ where });
    mockOtpSelect.mockReturnValue({ from });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
    mockInsert.mockReturnValue({ values });

    const res = await request(makeApp()).post('/devices/device-1/prekeys').send(VALID_PREKEYS_BODY);

    expect(res.status).toBe(200);
  });
});
