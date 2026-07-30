/**
 * Tests for the device-linking / re-authentication challenge flow (#333).
 *
 * A valid JWT is no longer sufficient to attach a device to an account: the
 * caller must additionally sign a server-issued, single-use, short-lived nonce
 * with the account wallet. These tests use the *real* nonce store and a real
 * Stellar keypair so single-use, expiry and signature checking are genuinely
 * exercised rather than mocked away.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockWalletFindMany = vi.fn();
const mockMemberFindMany = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst, findMany: vi.fn() },
      wallets: { findMany: mockWalletFindMany },
      conversationMembers: { findMany: mockMemberFindMany },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn(),
    select: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', identityPublicKey: 'identityPublicKey' },
  devicePrekeys: { deviceId: 'deviceId' },
  wallets: { userId: 'userId', address: 'address', isPrimary: 'isPrimary' },
  conversationMembers: { userId: 'userId', conversationId: 'conversationId' },
  messages: {},
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));
vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/deviceRevocation.js', () => ({ markDeviceRevoked: vi.fn() }));

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

const USER_ID = 'owner-user-id';
let currentAuth = { userId: USER_ID, deviceId: 'device-1' };

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: typeof currentAuth }).auth = currentAuth;
    next();
  },
}));

const { devicesRouter, deviceLinkChallengeLimiter, deviceLinkVerifyLimiter } =
  await import('../routes/devices.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/devices', devicesRouter);

/** Real keypair — the account wallet whose signature proves ownership. */
const walletKeypair = Keypair.random();
const WALLET = walletKeypair.publicKey();

const IDENTITY_KEY = Buffer.alloc(44, 7).toString('base64'); // 44-byte SPKI placeholder

const DEVICE_BODY = {
  deviceName: 'New Laptop',
  platform: 'web' as const,
  identityPublicKey: IDENTITY_KEY,
  registrationId: 4242,
};

function linkMessage(nonce: string, userId = USER_ID) {
  return `Link device to Clicked\nUser: ${userId}\nNonce: ${nonce}`;
}

/** Raw-message + hex signature (the wallet-kit encoding). */
function signRaw(message: string) {
  return walletKeypair.sign(Buffer.from(message)).toString('hex');
}

/** sha256("Stellar Signed Message:\n" + msg) + base64 signature (Freighter). */
function signFreighter(message: string) {
  const digest = createHash('sha256').update(`Stellar Signed Message:\n${message}`).digest();
  return walletKeypair.sign(digest).toString('base64');
}

function resetLimiters() {
  for (const key of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    deviceLinkChallengeLimiter.resetKey(key);
    deviceLinkVerifyLimiter.resetKey(key);
  }
}

function setupInsertChain(id = 'new-device-id', createdAt = new Date('2026-07-01T00:00:00.000Z')) {
  const returning = vi.fn().mockResolvedValue([{ id, createdAt }]);
  const values = vi.fn().mockReturnValue({ returning });
  mockInsert.mockReturnValue({ values });
  return { values, returning };
}

function setupUpdateChain(
  id = 'revoked-device-id',
  createdAt = new Date('2026-01-01T00:00:00.000Z'),
) {
  const returning = vi.fn().mockResolvedValue([{ id, createdAt }]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where, returning };
}

/** Ask for a challenge and return the issued nonce. */
async function getChallenge() {
  const res = await request(app).post('/devices/link/challenge').send({});
  expect(res.status).toBe(200);
  return res.body as { message: string; nonce: string; walletAddress: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLimiters();
  currentAuth = { userId: USER_ID, deviceId: 'device-1' };
  mockWalletFindMany.mockResolvedValue([{ userId: USER_ID, address: WALLET, isPrimary: true }]);
  mockDeviceFindFirst.mockResolvedValue(undefined);
  mockMemberFindMany.mockResolvedValue([]);
  setupInsertChain();
  setupUpdateChain();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── POST /devices/link/challenge ──────────────────────────────────────────────

describe('POST /devices/link/challenge', () => {
  it('issues a fresh nonce and the message to sign', async () => {
    const body = await getChallenge();

    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.walletAddress).toBe(WALLET);
    expect(body.message).toBe(linkMessage(body.nonce));
    // Distinct from the login message so signatures cannot cross over.
    expect(body.message).not.toContain('Sign in to Clicked');
  });

  it('issues a different nonce each time', async () => {
    const first = await getChallenge();
    const second = await getChallenge();

    expect(first.nonce).not.toBe(second.nonce);
  });

  it('returns 400 when the account has no wallet', async () => {
    mockWalletFindMany.mockResolvedValue([]);

    const res = await request(app).post('/devices/link/challenge').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wallet/i);
  });
});

// ── POST /devices/link/verify — success ───────────────────────────────────────

describe('POST /devices/link/verify — successful link', () => {
  it('registers a brand-new device after a valid signature', async () => {
    const { nonce } = await getChallenge();
    const { values } = setupInsertChain('new-device-id');

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('new-device-id');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        identityPublicKey: IDENTITY_KEY,
        deviceName: 'New Laptop',
        platform: 'web',
        registrationId: 4242,
      }),
    );
  });

  it('accepts the Freighter-style hashed/base64 signature encoding', async () => {
    const { nonce } = await getChallenge();

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signFreighter(linkMessage(nonce)) });

    expect(res.status).toBe(201);
  });

  it('re-activates a previously revoked device with the same identity key', async () => {
    mockDeviceFindFirst.mockResolvedValue({
      id: 'revoked-device-id',
      userId: USER_ID,
      identityPublicKey: IDENTITY_KEY,
      revokedAt: new Date('2026-02-02T00:00:00.000Z'),
    });
    const { set } = setupUpdateChain('revoked-device-id');

    const { nonce } = await getChallenge();

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('revoked-device-id');
    expect(mockInsert).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: null }));
  });

  it('returns 409 when the identity key is already an active device', async () => {
    mockDeviceFindFirst.mockResolvedValue({
      id: 'device-2',
      userId: USER_ID,
      identityPublicKey: IDENTITY_KEY,
      revokedAt: null,
    });

    const { nonce } = await getChallenge();

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('emits a device_added system event to the user conversations', async () => {
    mockMemberFindMany.mockResolvedValue([{ conversationId: 'conv-1', userId: USER_ID }]);
    const insertedMessage = { id: 'msg-1' };
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: () => ({ returning: () => Promise.resolve([insertedMessage]) }),
        }),
      }),
    );

    const { nonce } = await getChallenge();

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(201);
    // emitDeviceChangeEvent is fire-and-forget, so wait for it to land.
    await vi.waitFor(() => expect(mockTransaction).toHaveBeenCalled());
  });
});

// ── POST /devices/link/verify — rejections ────────────────────────────────────

describe('POST /devices/link/verify — nonce rejections', () => {
  it('rejects a stale (expired) nonce', async () => {
    // Fake only Date so supertest's real socket timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();

    const { nonce } = await getChallenge();

    // Past the 2-minute device-link TTL.
    vi.setSystemTime(issuedAt + 2 * 60 * 1000 + 1);

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/nonce/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('accepts a nonce just inside the TTL (expiry boundary is not over-eager)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();

    const { nonce } = await getChallenge();
    vi.setSystemTime(issuedAt + 2 * 60 * 1000 - 1000);

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(201);
  });

  it('rejects a reused nonce — the second verify fails (single-use)', async () => {
    const { nonce } = await getChallenge();
    const signature = signRaw(linkMessage(nonce));

    const first = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature });
    expect(first.status).toBe(201);

    mockInsert.mockClear();

    const second = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature });

    expect(second.status).toBe(401);
    expect(second.body.error).toMatch(/nonce/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects verify when no challenge was ever completed', async () => {
    const nonce = 'ffffffffffffffffffffffffffffffff';

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/nonce/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('burns the nonce even when the signature is wrong (no retry against one nonce)', async () => {
    const { nonce } = await getChallenge();

    const bad = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw('some other message') });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatch(/signature/i);

    // The nonce is gone, so even the correct signature no longer works.
    const retry = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce)) });
    expect(retry.status).toBe(401);
    expect(retry.body.error).toMatch(/nonce/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /devices/link/verify — signature rejections', () => {
  it('rejects a signature made by a different wallet', async () => {
    const attacker = Keypair.random();
    const { nonce } = await getChallenge();
    const signature = attacker.sign(Buffer.from(linkMessage(nonce))).toString('hex');

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a login signature replayed as a device-link proof', async () => {
    const { nonce } = await getChallenge();
    const loginMessage = `Sign in to Clicked\nWallet: ${WALLET}\nNonce: ${nonce}`;

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(loginMessage) });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("rejects a nonce issued to a different user's challenge", async () => {
    const { nonce } = await getChallenge();

    currentAuth = { userId: 'other-user-id', deviceId: 'device-9' };

    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce, signature: signRaw(linkMessage(nonce, 'other-user-id')) });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/nonce/i);
  });

  it('returns 400 for a malformed body (bad identityPublicKey)', async () => {
    const { nonce } = await getChallenge();

    const res = await request(app)
      .post('/devices/link/verify')
      .send({
        ...DEVICE_BODY,
        identityPublicKey: 'not-base64!!',
        nonce,
        signature: signRaw(linkMessage(nonce)),
      });

    expect(res.status).toBe(400);
  });

  it('returns 400 when signature or nonce is missing', async () => {
    const res = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY });

    expect(res.status).toBe(400);
  });
});

// ── The retired bare-registration path ────────────────────────────────────────

describe('POST /devices (retired bare registration)', () => {
  it('refuses JWT-only device registration and points at the link flow', async () => {
    const res = await request(app).post('/devices').send(DEVICE_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('/devices/link/challenge');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('Device link rate limiting', () => {
  it('blocks the 11th challenge request in a window', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/devices/link/challenge').send({});
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/devices/link/challenge').send({});
    expect(blocked.status).toBe(429);
  });

  it('blocks the 6th verify request in a window', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/devices/link/verify')
        .send({ ...DEVICE_BODY, nonce: 'never-issued', signature: 'deadbeef' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/devices/link/verify')
      .send({ ...DEVICE_BODY, nonce: 'never-issued', signature: 'deadbeef' });
    expect(blocked.status).toBe(429);
  });
});
