import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../lib/jwt.js';

const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

const mockDeviceFindFirst = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      devices: {
        findFirst: mockDeviceFindFirst,
      },
    },
    update: mockUpdate,
    select: vi.fn(),
  },
}));

const { usersRouter } = await import('../routes/users.js');
const { db } = await import('../db/index.js');

const app = express();
app.use(express.json());
app.use('/users', usersRouter);

const VALID_TOKEN = signToken({
  userId: 'auth-user-id',
  walletAddress: 'GAUTH',
  deviceId: 'device-test-id',
});
const AUTH_HEADER = `Bearer ${VALID_TOKEN}`;

const MOCK_USER = {
  id: 'user-uuid-123',
  username: 'testuser',
  avatarUrl: 'https://example.com/avatar.png',
  wallets: [
    { address: 'GABCDEFG', isPrimary: true },
    { address: 'GHIJKLMN', isPrimary: false },
  ],
};

const MOCK_CREATED_AT = new Date('2026-05-31T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: device is active; individual tests that need 401 from device checks can override.
  mockDeviceFindFirst.mockResolvedValue({ id: 'device-test-id', isRevoked: false });
});

describe('GET /users/me', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/users/me');
    expect(res.status).toBe(401);
  });

  it('returns the authenticated user profile with wallets and createdAt', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'auth-user-id',
      username: 'alice',
      avatarUrl: null,
      presenceVisible: true,
      wallets: MOCK_USER.wallets,
      createdAt: MOCK_CREATED_AT,
    } as never);

    const res = await request(app).get('/users/me').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'auth-user-id',
      username: 'alice',
      avatarUrl: null,
      presenceVisible: true,
      wallets: [
        { address: 'GABCDEFG', isPrimary: true },
        { address: 'GHIJKLMN', isPrimary: false },
      ],
      createdAt: MOCK_CREATED_AT.toISOString(),
    });
  });
});

describe('GET /users/:id', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/users/user-uuid-123');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .get('/users/user-uuid-123')
      .set('Authorization', 'Bearer invalid.token.value');
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is malformed', async () => {
    const res = await request(app)
      .get('/users/user-uuid-123')
      .set('Authorization', 'NotBearer token');
    expect(res.status).toBe(401);
  });

  it('returns 404 when user does not exist', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const res = await request(app).get('/users/unknown-uuid').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('returns 404 for a malformed (non-UUID) id', async () => {
    vi.mocked(db.query.users.findFirst).mockRejectedValue(
      new Error('invalid input syntax for type uuid'),
    );

    const res = await request(app).get('/users/not-a-valid-uuid').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('returns the user profile with wallets on success', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(MOCK_USER as never);

    const res = await request(app).get('/users/user-uuid-123').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(MOCK_USER.id);
    expect(res.body.username).toBe(MOCK_USER.username);
    expect(res.body.avatarUrl).toBe(MOCK_USER.avatarUrl);
    expect(res.body.wallets).toHaveLength(2);
    expect(res.body.wallets[0]).toEqual({ address: 'GABCDEFG', isPrimary: true });
    expect(res.body.wallets[1]).toEqual({ address: 'GHIJKLMN', isPrimary: false });
  });

  it('strips internal fields even if db returns them', async () => {
    const userWithInternals = {
      ...MOCK_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
      wallets: MOCK_USER.wallets.map((w) => ({
        ...w,
        id: 'wallet-uuid',
        userId: 'user-uuid-123',
        createdAt: new Date(),
      })),
    };
    vi.mocked(db.query.users.findFirst).mockResolvedValue(userWithInternals as never);

    const res = await request(app).get('/users/user-uuid-123').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    // Explicit serialization in handler ensures internal fields never reach the response
    expect(res.body).not.toHaveProperty('createdAt');
    expect(res.body).not.toHaveProperty('updatedAt');
    expect(res.body.wallets[0]).not.toHaveProperty('id');
    expect(res.body.wallets[0]).not.toHaveProperty('userId');
    expect(res.body.wallets[0]).not.toHaveProperty('createdAt');
  });
});

describe('GET /users/search', () => {
  beforeEach(() => {
    // The exists() subquery builds `db.select().from().where()` when the handler runs.
    const chain = { from: vi.fn(() => chain), where: vi.fn(() => chain) };
    vi.mocked(db.select).mockReturnValue(chain as any); // eslint-disable-line
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/users/search?q=test');
    expect(res.status).toBe(401);
  });

  it('returns 400 when q is missing', async () => {
    const res = await request(app).get('/users/search').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
  });

  it('returns 400 when q is empty or whitespace', async () => {
    const res = await request(app).get('/users/search?q=%20%20').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
  });

  it('returns mapped results with only the primary wallet address', async () => {
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      {
        id: 'user-uuid-123',
        username: 'testuser',
        avatarUrl: 'https://example.com/avatar.png',
        wallets: [
          { address: 'GABCDEFG', isPrimary: true },
          { address: 'GHIJKLMN', isPrimary: false },
        ],
      },
    ] as any); // eslint-disable-line

    const res = await request(app).get('/users/search?q=test').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 'user-uuid-123',
        username: 'testuser',
        avatarUrl: 'https://example.com/avatar.png',
        primaryWalletAddress: 'GABCDEFG',
      },
    ]);
    // No private wallet fields leak through.
    expect(res.body[0]).not.toHaveProperty('wallets');
  });

  it('returns null primaryWalletAddress when no primary wallet exists', async () => {
    vi.mocked(db.query.users.findMany).mockResolvedValue([
      { id: 'u1', username: 'nowallet', avatarUrl: null, wallets: [] },
    ] as any); // eslint-disable-line

    const res = await request(app)
      .get('/users/search?q=nowallet')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body[0].primaryWalletAddress).toBeNull();
  });

  it('caps results at 10 via the query limit', async () => {
    vi.mocked(db.query.users.findMany).mockResolvedValue([] as any); // eslint-disable-line

    await request(app).get('/users/search?q=test').set('Authorization', AUTH_HEADER);

    expect(vi.mocked(db.query.users.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });
});

describe('PATCH /users/me', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).patch('/users/me').send({ username: 'valid_name' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid username format', async () => {
    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', AUTH_HEADER)
      .send({ username: 'ab' }); // too short

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Username must be 3-30');
  });

  it('returns 409 for duplicate username', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'another-user-id',
      username: 'conflict',
    } as never);

    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', AUTH_HEADER)
      .send({ username: 'conflict' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Username is already taken');
  });

  it('returns 200 and updated user on success', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined); // no conflict

    const mockReturning = vi
      .fn()
      .mockResolvedValue([{ id: 'auth-user-id', username: 'new_name', avatarUrl: 'new_url' }]);
    const mockWhere = vi.fn(() => ({ returning: mockReturning }));
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', AUTH_HEADER)
      .send({ username: 'new_name', avatarUrl: 'new_url' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('new_name');
    expect(res.body.avatarUrl).toBe('new_url');
  });

  it('allows updating presenceVisible setting', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'auth-user-id',
      presenceVisible: true,
    } as any);

    const mockReturning = vi
      .fn()
      .mockResolvedValue([{ id: 'auth-user-id', username: 'alice', presenceVisible: false }]);
    const mockWhere = vi.fn(() => ({ returning: mockReturning }));
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', AUTH_HEADER)
      .send({ presenceVisible: false });

    expect(res.status).toBe(200);
    expect(res.body.presenceVisible).toBe(false);
  });

  it('returns 400 when presenceVisible is not a boolean', async () => {
    const res = await request(app)
      .patch('/users/me')
      .set('Authorization', AUTH_HEADER)
      .send({ presenceVisible: 'not-a-boolean' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('presenceVisible must be a boolean');
  });
});

describe('GET /users/:id/presence', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/users/user-uuid-123/presence');
    expect(res.status).toBe(401);
  });

  it('returns 404 when user does not exist', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const res = await request(app)
      .get('/users/unknown-uuid/presence')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('returns online: unknown when presenceVisible is false', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'user-uuid-123',
      presenceVisible: false,
    } as any);

    const res = await request(app)
      .get('/users/user-uuid-123/presence')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: 'unknown' });
  });

  it('returns online: false when presenceVisible is true but redis is not connected', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: 'user-uuid-123',
      presenceVisible: true,
    } as any);

    const res = await request(app)
      .get('/users/user-uuid-123/presence')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: false });
  });
});
