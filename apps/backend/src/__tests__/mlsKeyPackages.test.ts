/**
 * Tests for the MLS key package endpoints (#365).
 *
 *   POST /devices/:id/mls-key-packages
 *   GET  /users/:userId/devices/:deviceId/mls-key-package
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockTransaction = vi.fn();
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst },
      devicePrekeys: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      conversationMembers: { findMany: vi.fn().mockResolvedValue([]) },
    },
    select: mockSelect,
    insert: mockInsert,
    update: vi.fn(),
    delete: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  users: {},
  wallets: {},
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: {},
  conversationMembers: {},
  messages: {},
  mlsKeyPackages: {
    id: 'id',
    deviceId: 'deviceId',
    cipherSuite: 'cipherSuite',
    keyPackage: 'keyPackage',
    packageHash: 'packageHash',
    expiresAt: 'expiresAt',
    consumed: 'consumed',
    consumedAt: 'consumedAt',
    createdAt: 'createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  ne: vi.fn(),
  gt: vi.fn((col: unknown, val: unknown) => ({ op: 'gt', col, val })),
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  count: vi.fn(() => 'count(*)'),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  inArray: vi.fn(),
  ilike: vi.fn(),
  exists: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => ({ to: mockTo })) }));
vi.mock('../lib/conversationCache.js', () => ({ invalidateConversationCaches: vi.fn() }));
vi.mock('../services/deviceRevocation.js', () => ({ markDeviceRevoked: vi.fn() }));
vi.mock('../services/presence.js', () => ({
  isOnline: vi.fn().mockResolvedValue(false),
  deriveDevicePresence: vi.fn(),
}));
vi.mock('../services/deliveryPipeline.js', () => ({
  deviceRoom: (id: string) => `room:device:${id}`,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: OWNER_ID,
      deviceId: DEVICE_ID,
    };
    next();
  },
}));

const OWNER_ID = 'owner-user-id';
const DEVICE_ID = 'device-1';

const { devicesRouter } = await import('../routes/devices.js');
const { usersRouter } = await import('../routes/users.js');
const { MLS_KEY_PACKAGE_CAP, MLS_KEY_PACKAGE_LOW_WATERMARK } =
  await import('../services/mlsKeyPackages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  app.use('/users', usersRouter);
  return app;
}

/** Valid base64 for a `bytes`-long payload (within the 32–4096 byte window). */
function keyPackageOf(bytes: number, fill = 'A'): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

const PACKAGE_A = keyPackageOf(128, 'a');
const PACKAGE_B = keyPackageOf(128, 'b');

const ACTIVE_DEVICE = { id: DEVICE_ID, userId: OWNER_ID, revokedAt: null };

/** `db.select().from().where()` used by countAvailableKeyPackages. */
function setupAvailableCount(...totals: number[]) {
  mockSelect.mockReset();
  for (const total of totals) {
    mockSelect.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total }]),
      }),
    });
  }
}

/** `db.insert().values().onConflictDoNothing().returning()`. */
function setupInsert(insertedIds: string[]) {
  const returning = vi.fn().mockResolvedValue(insertedIds.map((id) => ({ id })));
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mockInsert.mockReturnValue({ values });
  return { values, returning };
}

/** `db.transaction()` used by claimKeyPackage. */
function setupClaim(candidate: Record<string, unknown> | null) {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              for: vi.fn().mockResolvedValue(candidate ? [candidate] : []),
            }),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) }),
  };
  mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
  return { tx, updateWhere };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTo.mockReturnValue({ emit: mockEmit });
});

// ── Upload ────────────────────────────────────────────────────────────────────

describe('POST /devices/:id/mls-key-packages', () => {
  const body = { cipherSuite: 1, keyPackages: [{ keyPackage: PACKAGE_A }] };

  it('returns 404 when the device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).post('/devices/nope/mls-key-packages').send(body);

    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the device owner', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'someone-else' });

    const res = await request(makeApp()).post(`/devices/${DEVICE_ID}/mls-key-packages`).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('returns 403 when the device is revoked', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, revokedAt: new Date() });

    const res = await request(makeApp()).post(`/devices/${DEVICE_ID}/mls-key-packages`).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it('rejects a key package that is not valid base64', async () => {
    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({ cipherSuite: 1, keyPackages: [{ keyPackage: 'not base64!!' }] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/base64/i);
  });

  it('rejects a key package below the minimum MLS size', async () => {
    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({ cipherSuite: 1, keyPackages: [{ keyPackage: keyPackageOf(8) }] });

    expect(res.status).toBe(400);
  });

  it('rejects a key package above the maximum MLS size', async () => {
    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({ cipherSuite: 1, keyPackages: [{ keyPackage: keyPackageOf(5000) }] });

    expect(res.status).toBe(400);
  });

  it('rejects an empty batch', async () => {
    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({ cipherSuite: 1, keyPackages: [] });

    expect(res.status).toBe(400);
  });

  it('rejects an already-expired key package', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);

    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({
        cipherSuite: 1,
        keyPackages: [{ keyPackage: PACKAGE_A, expiresAt: '2020-01-01T00:00:00.000Z' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expiresAt/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('stores a batch and reports the resulting inventory', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupAvailableCount(0);
    const { values } = setupInsert(['row-a', 'row-b']);

    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({
        cipherSuite: 1,
        keyPackages: [{ keyPackage: PACKAGE_A }, { keyPackage: PACKAGE_B }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: 2, duplicates: 0, capped: false, remaining: 2 });

    // Only public material plus derived metadata is persisted.
    const rows = values.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ deviceId: DEVICE_ID, cipherSuite: 1, keyPackage: PACKAGE_A });
    expect(rows[0]!['packageHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!['expiresAt']).toBeNull();
  });

  it('collapses duplicates inside a single batch', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupAvailableCount(0);
    const { values } = setupInsert(['row-a']);

    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({
        cipherSuite: 1,
        keyPackages: [{ keyPackage: PACKAGE_A }, { keyPackage: PACKAGE_A }],
      });

    expect(res.status).toBe(200);
    expect((values.mock.calls[0]![0] as unknown[]).length).toBe(1);
    expect(res.body.uploaded).toBe(1);
  });

  it('reports packages the device had already published as duplicates', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupAvailableCount(5);
    // Two sent, one survives the ON CONFLICT DO NOTHING.
    setupInsert(['row-b']);

    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({
        cipherSuite: 1,
        keyPackages: [{ keyPackage: PACKAGE_A }, { keyPackage: PACKAGE_B }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: 1, duplicates: 1, capped: false, remaining: 6 });
  });

  it('returns 422 when the per-device cap is already reached', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupAvailableCount(MLS_KEY_PACKAGE_CAP);

    const res = await request(makeApp()).post(`/devices/${DEVICE_ID}/mls-key-packages`).send(body);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/cap/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('trims the batch to the remaining cap space', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupAvailableCount(MLS_KEY_PACKAGE_CAP - 1); // one slot left
    const { values } = setupInsert(['row-a']);

    const res = await request(makeApp())
      .post(`/devices/${DEVICE_ID}/mls-key-packages`)
      .send({
        cipherSuite: 1,
        keyPackages: [{ keyPackage: PACKAGE_A }, { keyPackage: PACKAGE_B }],
      });

    expect(res.status).toBe(200);
    expect((values.mock.calls[0]![0] as unknown[]).length).toBe(1);
    expect(res.body.capped).toBe(true);
    expect(res.body.remaining).toBe(MLS_KEY_PACKAGE_CAP);
  });
});

// ── Fetch + consume ───────────────────────────────────────────────────────────

describe('GET /users/:userId/devices/:deviceId/mls-key-package', () => {
  const url = `/users/${OWNER_ID}/devices/${DEVICE_ID}/mls-key-package`;

  it('returns 404 when the device does not exist', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/nope/mls-key-package`);

    expect(res.status).toBe(404);
  });

  it('returns 404 when :userId does not own the device', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, userId: 'someone-else' });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(404);
  });

  it('returns 404 when the device is revoked', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...ACTIVE_DEVICE, revokedAt: new Date() });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric cipherSuite filter', async () => {
    const res = await request(makeApp()).get(`${url}?cipherSuite=abc`);

    expect(res.status).toBe(400);
  });

  it('claims one package and marks it consumed in the same transaction', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    const { updateWhere } = setupClaim({
      id: 'kp-1',
      cipherSuite: 1,
      keyPackage: PACKAGE_A,
      expiresAt: null,
    });
    setupAvailableCount(MLS_KEY_PACKAGE_LOW_WATERMARK + 5);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deviceId: DEVICE_ID,
      cipherSuite: 1,
      keyPackage: PACKAGE_A,
      remaining: MLS_KEY_PACKAGE_LOW_WATERMARK + 5,
    });
    // consumed flipped inside the claim transaction rather than the row deleted
    expect(updateWhere).toHaveBeenCalled();
  });

  it('does not emit a replenishment signal while stock is healthy', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupClaim({ id: 'kp-1', cipherSuite: 1, keyPackage: PACKAGE_A, expiresAt: null });
    setupAvailableCount(MLS_KEY_PACKAGE_LOW_WATERMARK + 1);

    await request(makeApp()).get(url);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits mls_key_packages_low to the device and its owner at the watermark', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupClaim({ id: 'kp-1', cipherSuite: 1, keyPackage: PACKAGE_A, expiresAt: null });
    setupAvailableCount(MLS_KEY_PACKAGE_LOW_WATERMARK);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(mockTo).toHaveBeenCalledWith(`room:device:${DEVICE_ID}`);
    expect(mockTo).toHaveBeenCalledWith(`room:user:${OWNER_ID}`);
    expect(mockEmit).toHaveBeenCalledWith(
      'mls_key_packages_low',
      expect.objectContaining({
        deviceId: DEVICE_ID,
        remaining: MLS_KEY_PACKAGE_LOW_WATERMARK,
        threshold: MLS_KEY_PACKAGE_LOW_WATERMARK,
      }),
    );
  });

  it('returns 409 and signals replenishment when the device is exhausted', async () => {
    mockDeviceFindFirst.mockResolvedValue(ACTIVE_DEVICE);
    setupClaim(null);
    setupAvailableCount(0);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(409);
    expect(res.body.remaining).toBe(0);
    expect(mockEmit).toHaveBeenCalledWith('mls_key_packages_low', expect.anything());
  });
});
