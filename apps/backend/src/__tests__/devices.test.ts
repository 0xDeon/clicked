import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../lib/jwt.js';

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
  },
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

const { devicesRouter } = await import('../routes/devices.js');
const { db } = await import('../db/index.js');

const app = express();
app.use(express.json());
app.use('/devices', devicesRouter);

const USER_ID = 'auth-user-id';
const CURRENT_DEVICE_ID = 'device-row-1';
const TOKEN = signToken({ userId: USER_ID, walletAddress: 'GAUTH', deviceId: CURRENT_DEVICE_ID });
const AUTH_HEADER = `Bearer ${TOKEN}`;

const CREATED_AT = new Date('2026-05-31T12:00:00.000Z');

// As the DB orders them: active devices first, then revoked.
const ROWS = [
  {
    id: CURRENT_DEVICE_ID,
    userId: USER_ID,
    identityPublicKey: 'key-active-1',
    deviceName: 'Phone',
    platform: 'ios',
    lastSeenAt: CREATED_AT,
    revokedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  {
    id: 'device-row-2',
    userId: USER_ID,
    identityPublicKey: 'key-active-2',
    deviceName: 'Laptop',
    platform: 'web',
    lastSeenAt: CREATED_AT,
    revokedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  {
    id: 'device-row-3',
    userId: USER_ID,
    identityPublicKey: 'key-revoked',
    deviceName: 'Old tablet',
    platform: 'android',
    lastSeenAt: CREATED_AT,
    revokedAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
];

function mockOtpCounts(rows: Array<{ deviceId: string; remaining: number }>) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ groupBy });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // requireAuth calls db.query.devices.findFirst to verify the device exists and is active.
  vi.mocked(db.query.devices.findFirst).mockResolvedValue({
    id: CURRENT_DEVICE_ID,
    userId: USER_ID,
    identityPublicKey: 'key-active-1',
    revokedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  } as never);
  mockOtpCounts([]);
});

describe('GET /devices', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/devices');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token is invalid', async () => {
    const res = await request(app).get('/devices').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('scopes the query to the authenticated user only', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue([] as never);

    await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    const arg = vi.mocked(db.query.devices.findMany).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).toHaveProperty('where');
    expect(arg).toHaveProperty('orderBy');
  });

  it('returns the devices including revoked ones, preserving active-first order', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue(ROWS as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual([
      CURRENT_DEVICE_ID,
      'device-row-2',
      'device-row-3',
    ]);

    expect(res.body[2].revokedAt).toBe(CREATED_AT.toISOString());
    expect(res.body[0].revokedAt).toBeNull();
  });

  it('flags only the device from the caller JWT as current', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue(ROWS as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: CURRENT_DEVICE_ID, current: true });
    expect(res.body[1].current).toBe(false);
    expect(res.body[2].current).toBe(false);
  });

  it('returns 401 when the JWT carries no deviceId', async () => {
    const tokenNoDevice = signToken({ userId: USER_ID, walletAddress: 'GAUTH', deviceId: '' });

    const res = await request(app).get('/devices').set('Authorization', `Bearer ${tokenNoDevice}`);

    expect(res.status).toBe(401);
  });

  it('includes oneTimePreKeysRemaining per device', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue([ROWS[0]] as never);
    mockOtpCounts([{ deviceId: CURRENT_DEVICE_ID, remaining: 7 }]);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body[0].oneTimePreKeysRemaining).toBe(7);
  });

  it('defaults oneTimePreKeysRemaining to 0 when no prekeys exist', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue([ROWS[0]] as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body[0].oneTimePreKeysRemaining).toBe(0);
  });

  it('returns the exact response shape with no leaked internal fields', async () => {
    vi.mocked(db.query.devices.findMany).mockResolvedValue([ROWS[0]] as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body[0]).sort()).toEqual(
      [
        'createdAt',
        'current',
        'id',
        'identityPublicKey',
        'deviceName',
        'platform',
        'lastSeenAt',
        'revokedAt',
        'capabilities',
        'oneTimePreKeysRemaining',
      ].sort(),
    );
    expect(res.body[0]).not.toHaveProperty('userId');
    expect(res.body[0]).not.toHaveProperty('updatedAt');
  });

  it('returns 500 when the database query fails', async () => {
    vi.mocked(db.query.devices.findMany).mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to list devices' });
  });
});
