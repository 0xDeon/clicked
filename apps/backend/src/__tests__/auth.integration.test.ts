import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ── Mocks (must be declared before any imports that use them) ─────────────

const mockCreateNonce = vi.fn(() => 'test-nonce-abc123');
const mockConsumeNonce = vi.fn();

vi.mock('../lib/nonce.js', () => ({
  createNonce: mockCreateNonce,
  consumeNonce: mockConsumeNonce,
}));

const mockWalletFindFirst = vi.fn();
const mockDeviceFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn(() => ({
  set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      wallets: { findFirst: mockWalletFindFirst },
      devices: { findFirst: mockDeviceFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
    execute: vi.fn().mockResolvedValue([]),
  },
}));

const mockVerify = vi.fn(() => true);
vi.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: vi.fn(() => ({ verify: mockVerify })),
  },
}));

// ── Import app after mocks are registered ─────────────────────────────────

const { app } = await import('../app.js');
const { challengeLimiter, verifyLimiter } = await import('../routes/auth.js');

function resetRateLimiters() {
  challengeLimiter.resetKey('127.0.0.1');
  verifyLimiter.resetKey('127.0.0.1');
}

// ── Helpers ───────────────────────────────────────────────────────────────

const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789AB';
const SIGNATURE = 'aabbccdd';
const NONCE = 'test-nonce-abc123';
const IDENTITY_KEY = Buffer.alloc(44, 1).toString('base64'); // 44-byte SPKI placeholder

function setupInsert(userId = 'new-user-id', deviceId = 'new-device-id') {
  // New-user flow inserts: users → wallets → devices (3 calls total).
  const userReturning = vi.fn().mockResolvedValue([{ id: userId }]);
  const walletReturning = vi.fn().mockResolvedValue([]);
  const deviceReturning = vi.fn().mockResolvedValue([{ id: deviceId }]);
  const userValues = vi.fn().mockReturnValue({ returning: userReturning });
  const walletValues = vi.fn().mockReturnValue({ returning: walletReturning });
  const deviceValues = vi.fn().mockReturnValue({ returning: deviceReturning });
  mockInsert
    .mockReturnValueOnce({ values: userValues })
    .mockReturnValueOnce({ values: walletValues })
    .mockReturnValueOnce({ values: deviceValues });
  return { userReturning, walletReturning, deviceReturning };
}

function setupExistingUserInsert(deviceId = 'device-id') {
  // Only the device insert is called for an existing wallet.
  const deviceReturning = vi.fn().mockResolvedValue([{ id: deviceId }]);
  const deviceValues = vi.fn().mockReturnValue({ returning: deviceReturning });
  mockInsert.mockReturnValue({ values: deviceValues });
  return { deviceReturning };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('POST /auth/challenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimiters();
  });

  it('returns 200 with message and nonce for valid walletAddress', async () => {
    const res = await request(app).post('/auth/challenge').send({ walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nonce', NONCE);
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).toContain(WALLET);
    expect(mockCreateNonce).toHaveBeenCalledWith(WALLET);
  });

  it('returns 400 with error when walletAddress is missing', async () => {
    const res = await request(app).post('/auth/challenge').send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(mockCreateNonce).not.toHaveBeenCalled();
  });

  it('returns 400 when body is completely absent', async () => {
    const res = await request(app)
      .post('/auth/challenge')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimiters();
  });

  it('returns 200 with JWT token for valid new-user flow', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(true);
    mockWalletFindFirst.mockResolvedValue(undefined); // no existing wallet → create user
    mockDeviceFindFirst.mockResolvedValue(undefined); // no existing device → create device
    setupInsert();

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    const parts = (res.body.token as string).split('.');
    expect(parts).toHaveLength(3); // valid JWT structure
  });

  it('returns 200 with JWT for existing wallet and existing device (returning user)', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(true);
    mockWalletFindFirst.mockResolvedValue({ userId: 'existing-user-id', address: WALLET });
    mockDeviceFindFirst.mockResolvedValue({ id: 'device-id', isRevoked: false });

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('returns 200 with JWT for existing wallet and new device', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(true);
    mockWalletFindFirst.mockResolvedValue({ userId: 'existing-user-id', address: WALLET });
    mockDeviceFindFirst.mockResolvedValue(undefined); // new device for existing user
    setupExistingUserInsert();

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('returns 401 when nonce is expired or invalid', async () => {
    mockConsumeNonce.mockReturnValue(false);

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: 'expired-nonce',
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 when signature verification fails', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(false);

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: 'badsig',
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 401 when device is revoked', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(true);
    mockWalletFindFirst.mockResolvedValue({ userId: 'existing-user-id', address: WALLET });
    mockDeviceFindFirst.mockResolvedValue({ id: 'device-id', isRevoked: true });

    const res = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/auth/verify').send({ walletAddress: WALLET });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when all fields are absent', async () => {
    const res = await request(app).post('/auth/verify').send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when identityPublicKey is missing', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .send({ walletAddress: WALLET, signature: SIGNATURE, nonce: NONCE });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 when Stellar Keypair throws (malformed wallet address)', async () => {
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockImplementation(() => {
      throw new Error('invalid key');
    });

    const res = await request(app).post('/auth/verify').send({
      walletAddress: 'INVALID',
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });
});

describe('Auth rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimiters();
    mockConsumeNonce.mockReturnValue(true);
    mockVerify.mockReturnValue(true);
    mockWalletFindFirst.mockResolvedValue({ userId: 'existing-user-id', address: WALLET });
    mockDeviceFindFirst.mockResolvedValue({ id: 'device-id', isRevoked: false });
  });

  it('allows up to 10 /auth/challenge requests per minute, blocks the 11th with 429', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/auth/challenge').send({ walletAddress: WALLET });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/auth/challenge').send({ walletAddress: WALLET });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('allows up to 5 /auth/verify requests per minute, blocks the 6th with 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/auth/verify').send({
        walletAddress: WALLET,
        signature: SIGNATURE,
        nonce: NONCE,
        identityPublicKey: IDENTITY_KEY,
      });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('challenge and verify limiters are independent', async () => {
    // Exhaust verify limit
    for (let i = 0; i < 5; i++) {
      await request(app).post('/auth/verify').send({
        walletAddress: WALLET,
        signature: SIGNATURE,
        nonce: NONCE,
        identityPublicKey: IDENTITY_KEY,
      });
    }
    const verifyBlocked = await request(app).post('/auth/verify').send({
      walletAddress: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
      identityPublicKey: IDENTITY_KEY,
    });
    expect(verifyBlocked.status).toBe(429);

    // Challenge limit should still allow requests
    const challengeRes = await request(app).post('/auth/challenge').send({ walletAddress: WALLET });
    expect(challengeRes.status).toBe(200);
  });

  it('does not affect authenticated routes (/me returns its normal status under heavy load)', async () => {
    // Hammer /me well past the auth limits — it must not return 429
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/me');
      expect(res.status).not.toBe(429);
    }
  });

  it('does not affect the /health endpoint under heavy load', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get('/health');
      expect(res.status).not.toBe(429);
    }
  });
});
