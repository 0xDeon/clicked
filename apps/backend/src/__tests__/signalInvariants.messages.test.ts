/**
 * Signal-invariant guard for POST /messages: only opaque ciphertext and
 * public routing metadata (recipient device id) may ever be sent to the
 * server. `SendMessageSchema` / `EnvelopeSchema` are `.strict()` so an
 * unrecognized field — e.g. a client attaching session or ratchet state —
 * fails validation with 400 instead of being silently stripped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockFindMembers = vi.fn();
const mockFindMessage = vi.fn();

vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));
vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindMembers, findMany: vi.fn().mockResolvedValue([]) },
      messages: { findFirst: mockFindMessage },
    },
    transaction: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  messages: { id: 'id' },
  messageEnvelopes: {},
  devices: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
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

const { messagesRouter } = await import('../routes/messages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/messages', messagesRouter);
  return app;
}

const VALID_BODY = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  contentType: 'text',
  envelopes: [{ recipientDeviceId: '33333333-3333-4333-8333-333333333333', ciphertext: 'abc' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /messages — session/private-key state rejection', () => {
  it('rejects an unrecognized top-level field with 400', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({ ...VALID_BODY, sessionState: 'opaque-blob' });

    expect(res.status).toBe(400);
    expect(mockFindMembers).not.toHaveBeenCalled();
  });

  it('rejects ratchet state with 400', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({ ...VALID_BODY, ratchetState: { rootKey: 'x', chainKey: 'y' } });

    expect(res.status).toBe(400);
    expect(mockFindMembers).not.toHaveBeenCalled();
  });

  it('rejects a private key nested inside an envelope entry with 400', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...VALID_BODY,
        envelopes: [{ ...VALID_BODY.envelopes[0], privateKey: 'should-never-leave-the-client' }],
      });

    expect(res.status).toBe(400);
    expect(mockFindMembers).not.toHaveBeenCalled();
  });
});
