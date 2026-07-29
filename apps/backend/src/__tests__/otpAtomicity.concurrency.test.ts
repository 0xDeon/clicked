/**
 * OTP single-use atomicity under concurrency (GET
 * /users/:userId/devices/:deviceId/key-bundle).
 *
 * The route claims a one-time prekey inside `db.transaction` using
 * `SELECT ... FOR UPDATE SKIP LOCKED` (routes/users.ts) so two concurrent
 * X3DH bundle fetches can never be handed the same prekey. Since this test
 * suite mocks the DB rather than talking to a real Postgres instance, the
 * fake transaction below models the exact guarantee `FOR UPDATE SKIP LOCKED`
 * gives: a row selected inside an in-flight transaction is invisible to
 * every other transaction's SELECT until it commits. An `await` is inserted
 * between the fake SELECT and UPDATE — the same window where a race would
 * surface if the route ever lost its locking — so truly concurrent callers
 * interleave through it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

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
  sql: vi.fn(),
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

/**
 * Fake row store modeling `SELECT ... FOR UPDATE SKIP LOCKED` semantics: a
 * row claimed by one in-flight transaction is skipped by every other
 * transaction's candidate SELECT until the claiming transaction's UPDATE
 * "commits" (releases the lock).
 */
function createFakeOtpStore(seedCount: number) {
  const rows = Array.from({ length: seedCount }, (_, i) => ({
    id: `otp-${i}`,
    keyId: i,
    publicKey: `pub-${i}`,
    consumed: false,
  }));
  const locked = new Set<string>();

  function makeTx() {
    let claimedId: string | null = null;
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                for: async () => {
                  const candidate = rows.find((r) => !r.consumed && !locked.has(r.id));
                  if (!candidate) return [];
                  locked.add(candidate.id);
                  claimedId = candidate.id;
                  // The race window: another concurrent transaction's SELECT
                  // runs somewhere in here, before this transaction's UPDATE
                  // has released the lock.
                  await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
                  return [
                    { id: candidate.id, keyId: candidate.keyId, publicKey: candidate.publicKey },
                  ];
                },
              }),
            }),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            if (!claimedId) return;
            const row = rows.find((r) => r.id === claimedId);
            if (row) row.consumed = true;
            locked.delete(claimedId);
            claimedId = null;
          },
        }),
      }),
    };
  }

  return { rows, makeTx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeviceFindFirst.mockResolvedValue(DEVICE);
  mockPrekeyFindFirst.mockResolvedValue(SIGNED_PRE_KEY);
});

describe('OTP single-use atomicity under concurrent bundle fetches', () => {
  it('never hands the same one-time prekey to two concurrent callers', async () => {
    const OTP_COUNT = 5;
    const CONCURRENT_REQUESTS = 12;

    const store = createFakeOtpStore(OTP_COUNT);
    mockTransaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(store.makeTx()));

    const app = makeApp();
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        request(app).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`),
      ),
    );

    expect(responses.every((res) => res.status === 200)).toBe(true);

    const claimedKeyIds = responses
      .map((res) => res.body.oneTimePreKey?.keyId)
      .filter((keyId): keyId is number => typeof keyId === 'number');

    const exhausted = responses.filter((res) => res.body.oneTimePreKey === null);

    // Exactly the seeded number of prekeys were handed out, never more —
    // and every one was distinct (no double-claim).
    expect(claimedKeyIds).toHaveLength(OTP_COUNT);
    expect(new Set(claimedKeyIds).size).toBe(OTP_COUNT);

    // The rest gracefully fall back to a signed-prekey-only bundle.
    expect(exhausted).toHaveLength(CONCURRENT_REQUESTS - OTP_COUNT);

    // Every seeded row ended up consumed exactly once.
    expect(store.rows.every((r) => r.consumed)).toBe(true);
  });

  it('falls back to a null one-time prekey once the pool is exhausted, without erroring', async () => {
    const store = createFakeOtpStore(0);
    mockTransaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(store.makeTx()));

    const res = await request(makeApp()).get(`/users/${OWNER_ID}/devices/device-2/key-bundle`);

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKey).toBeNull();
    expect(res.body.signedPreKey).toEqual(SIGNED_PRE_KEY);
  });
});
