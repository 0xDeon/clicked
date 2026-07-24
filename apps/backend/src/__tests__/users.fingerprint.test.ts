/**
 * Tests for GET /users/:id/key-fingerprint (issue #162)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHash } from 'node:crypto';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUserFindFirst = vi.fn();
const mockDeviceFindFirst = vi.fn();
const mockDeviceFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: { findFirst: mockUserFindFirst, findMany: vi.fn() },
      devices: { findFirst: mockDeviceFindFirst, findMany: mockDeviceFindMany },
      wallets: { findFirst: vi.fn() },
    },
    update: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  users: { id: 'id', username: 'username' },
  wallets: {},
  devices: { userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: { deviceId: 'deviceId', keyType: 'keyType', consumed: 'consumed' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  ilike: vi.fn(),
  exists: vi.fn(),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  sql: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
}));

vi.mock('../services/presence.js', () => ({
  isOnline: vi.fn().mockResolvedValue(false),
}));

// Stub requireAuth — inject device-id so the real middleware path doesn't run.
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

// ── Fingerprint derivation helper (mirrors the route implementation) ──────────

function deriveFingerprint(identityKeys: string[]): string {
  const sorted = [...identityKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const concatenated = sorted.join('\n');
  const digest = createHash('sha256').update(concatenated, 'utf8').digest();

  function bytesToSegment(buf: Buffer, offset: number, length: number): string {
    let value = BigInt(0);
    for (let i = 0; i < length; i++) {
      value = (value << BigInt(8)) | BigInt(buf[offset + i]!);
    }
    return (value % BigInt('1' + '0'.repeat(30))).toString().padStart(30, '0');
  }

  return bytesToSegment(digest, 0, 15) + bytesToSegment(digest, 15, 15);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated device is active.
  mockDeviceFindFirst.mockResolvedValue({ id: 'caller-device', revokedAt: null });
});

describe('GET /users/:id/key-fingerprint', () => {
  it('returns 404 when user does not exist', async () => {
    mockUserFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/users/unknown-id/key-fingerprint');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 when user has no active devices', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user-1' });
    mockDeviceFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/users/user-1/key-fingerprint');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active devices/i);
  });

  it('returns a 60-digit fingerprint and 12 × 5-digit formatted safety number', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user-1' });
    mockDeviceFindMany.mockResolvedValue([
      { identityPublicKey: 'a2V5QQ==' },
      { identityPublicKey: 'a2V5Qg==' },
    ]);

    const res = await request(makeApp()).get('/users/user-1/key-fingerprint');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('userId', 'user-1');
    expect(res.body).toHaveProperty('fingerprint');
    expect(res.body).toHaveProperty('formatted');

    const { fingerprint, formatted } = res.body as { fingerprint: string; formatted: string };

    // Fingerprint must be exactly 60 numeric digits.
    expect(fingerprint).toHaveLength(60);
    expect(fingerprint).toMatch(/^\d{60}$/);

    // Formatted must be 12 groups of 5 digits separated by spaces.
    expect(formatted).toMatch(/^(\d{5} ){11}\d{5}$/);

    // Raw and formatted must contain the same digits.
    expect(formatted.replace(/ /g, '')).toBe(fingerprint);
  });

  it('is deterministic: same keys → same fingerprint regardless of input order', async () => {
    const keys = ['a2V5Qg==', 'a2V5QQ==']; // reverse order vs. previous test

    mockUserFindFirst.mockResolvedValue({ id: 'user-1' });
    mockDeviceFindMany.mockResolvedValue(keys.map((k) => ({ identityPublicKey: k })));

    const res = await request(makeApp()).get('/users/user-1/key-fingerprint');

    expect(res.status).toBe(200);
    const expected = deriveFingerprint(keys);
    expect(res.body.fingerprint).toBe(expected);
  });

  it('produces a different fingerprint for different key sets', async () => {
    const fp1 = deriveFingerprint(['a2V5QQ==']);
    const fp2 = deriveFingerprint(['a2V5Qg==']);
    expect(fp1).not.toBe(fp2);
  });

  it('single-device user gets a valid 60-digit fingerprint', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user-1' });
    mockDeviceFindMany.mockResolvedValue([{ identityPublicKey: 'c2luZ2xlRGV2aWNlS2V5' }]);

    const res = await request(makeApp()).get('/users/user-1/key-fingerprint');

    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toHaveLength(60);
  });
});
