/**
 * Tests for GET /push/vapid-public-key (#349).
 *
 * The frontend must source the VAPID public key from the backend instead of
 * a separately-configured build-time env var, so the two can never drift out
 * of sync with the private key the backend actually signs pushes with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../db/index.js', () => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  pushSubscriptions: {
    deviceId: 'device_id',
    endpoint: 'endpoint',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'device-1',
    };
    next();
  },
}));

const { pushRouter } = await import('../routes/push.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/push', pushRouter);
  return app;
}

describe('GET /push/vapid-public-key', () => {
  const ORIGINAL_PUBLIC_KEY = process.env['VAPID_PUBLIC_KEY'];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_KEY === undefined) delete process.env['VAPID_PUBLIC_KEY'];
    else process.env['VAPID_PUBLIC_KEY'] = ORIGINAL_PUBLIC_KEY;
  });

  it('returns the configured VAPID public key', async () => {
    process.env['VAPID_PUBLIC_KEY'] = 'test-vapid-public-key';

    const res = await request(makeApp()).get('/push/vapid-public-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, vapidPublicKey: 'test-vapid-public-key' });
  });

  it('returns configured: false when VAPID is not set up on the backend', async () => {
    delete process.env['VAPID_PUBLIC_KEY'];

    const res = await request(makeApp()).get('/push/vapid-public-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, vapidPublicKey: null });
  });

  it('returns configured: false when the env var is set but empty', async () => {
    process.env['VAPID_PUBLIC_KEY'] = '';

    const res = await request(makeApp()).get('/push/vapid-public-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, vapidPublicKey: null });
  });
});
