/**
 * Tests for the Phase-1 → Signal migration HTTP surface (#364):
 *
 *   PATCH /devices/:id/capabilities        advertise Signal support
 *   GET   /conversations/:id/e2ee-protocol what new messages must use
 *   POST  /messages                        enforcement + per-envelope protocol
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockDeviceFindMany = vi.fn();
const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockTransaction = vi.fn();
const mockNegotiate = vi.fn();
const mockCheckEnvelopeProtocols = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst, findMany: mockDeviceFindMany },
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      messages: { findFirst: mockMessageFindFirst },
      conversations: { findFirst: vi.fn(), findMany: vi.fn() },
      devicePrekeys: { findFirst: vi.fn() },
    },
    update: mockUpdate,
    insert: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: {},
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  conversations: { id: 'id' },
  messages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt' },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
  mlsKeyPackages: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  asc: vi.fn((col: unknown) => col),
  count: vi.fn(),
  desc: vi.fn((col: unknown) => col),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  gt: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  ne: vi.fn(),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  sql: vi.fn(),
}));

vi.mock('../lib/redis.js', () => ({
  redis: null,
  CONV_CACHE_TTL: 60,
  convCacheKey: (id: string) => `conv:${id}`,
}));
vi.mock('../lib/conversationCache.js', () => ({ invalidateConversationCaches: vi.fn() }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));
vi.mock('../services/roomManager.js', () => ({
  conversationRoom: (id: string) => `room:conversation:${id}`,
}));
vi.mock('../services/deviceRevocation.js', () => ({ markDeviceRevoked: vi.fn() }));
vi.mock('../services/fileCleanup.js', () => ({ softDeleteFile: vi.fn() }));
vi.mock('../services/mlsKeyPackages.js', () => ({
  MLS_KEY_PACKAGE_CAP: 100,
  MLS_KEY_PACKAGE_MAX_BATCH: 100,
  countAvailableKeyPackages: vi.fn(),
  hashKeyPackage: vi.fn(),
}));
vi.mock('../services/e2eeProtocol.js', () => ({
  negotiateConversationProtocol: mockNegotiate,
  checkEnvelopeProtocols: mockCheckEnvelopeProtocols,
}));

const USER_ID = 'user-1';
const DEVICE_ID = 'device-1';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: USER_ID,
      deviceId: DEVICE_ID,
    };
    next();
  },
}));

const { devicesRouter } = await import('../routes/devices.js');
const { conversationsRouter } = await import('../routes/conversations.js');
const { messagesRouter } = await import('../routes/messages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  app.use('/conversations', conversationsRouter);
  app.use('/messages', messagesRouter);
  return app;
}

const PHASE1_DEVICE = {
  id: DEVICE_ID,
  userId: USER_ID,
  revokedAt: null,
  supportsSignal: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockMemberFindMany.mockResolvedValue([{ userId: USER_ID }]);
});

// ── Capability advertisement ──────────────────────────────────────────────────

describe('PATCH /devices/:id/capabilities', () => {
  const url = `/devices/${DEVICE_ID}/capabilities`;

  function setupUpdate() {
    const where = vi.fn().mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where }) });
    return where;
  }

  it('turns Signal support on', async () => {
    mockDeviceFindFirst.mockResolvedValue(PHASE1_DEVICE);
    const where = setupUpdate();

    const res = await request(makeApp()).patch(url).send({ supportsSignal: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: DEVICE_ID, supportsSignal: true, changed: true });
    expect(where).toHaveBeenCalled();
  });

  it('is idempotent when the flag already matches', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...PHASE1_DEVICE, supportsSignal: true });

    const res = await request(makeApp()).patch(url).send({ supportsSignal: true });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to withdraw Signal support', async () => {
    // Allowing this would let any client walk the conversation back onto the
    // weaker Phase-1 construction.
    mockDeviceFindFirst.mockResolvedValue({ ...PHASE1_DEVICE, supportsSignal: true });

    const res = await request(makeApp()).patch(url).send({ supportsSignal: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot be withdrawn/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('allows an explicit false while the device has never advertised', async () => {
    mockDeviceFindFirst.mockResolvedValue(PHASE1_DEVICE);

    const res = await request(makeApp()).patch(url).send({ supportsSignal: false });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
  });

  it('returns 403 for a device the caller does not own', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...PHASE1_DEVICE, userId: 'someone-else' });

    const res = await request(makeApp()).patch(url).send({ supportsSignal: true });

    expect(res.status).toBe(403);
  });

  it('returns 403 for a revoked device', async () => {
    mockDeviceFindFirst.mockResolvedValue({ ...PHASE1_DEVICE, revokedAt: new Date() });

    const res = await request(makeApp()).patch(url).send({ supportsSignal: true });

    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown device', async () => {
    mockDeviceFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).patch(url).send({ supportsSignal: true });

    expect(res.status).toBe(404);
  });

  it('rejects a non-boolean flag', async () => {
    const res = await request(makeApp()).patch(url).send({ supportsSignal: 'yes' });

    expect(res.status).toBe(400);
  });
});

// ── Negotiation endpoint ──────────────────────────────────────────────────────

describe('GET /conversations/:id/e2ee-protocol', () => {
  const url = `/conversations/${CONVERSATION_ID}/e2ee-protocol`;

  it('reports the protocol and what is blocking the cutover', async () => {
    mockNegotiate.mockResolvedValue({
      protocol: 'sealed_box',
      totalActiveDevices: 3,
      signalCapableDevices: 2,
      blockingDevices: [
        { deviceId: 'd3', userId: 'user-2', deviceName: 'old phone', platform: 'ios' },
      ],
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      conversationId: CONVERSATION_ID,
      protocol: 'sealed_box',
      signalCapableDevices: 2,
    });
    expect(res.body.blockingDevices[0].deviceName).toBe('old phone');
  });

  it('returns 403 for a non-member', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(mockNegotiate).not.toHaveBeenCalled();
  });
});

// ── Device set carries capability + negotiated protocol ───────────────────────

describe('GET /conversations/:id/devices', () => {
  it('returns the negotiated protocol alongside each device capability', async () => {
    mockDeviceFindMany.mockResolvedValue([
      {
        id: DEVICE_ID,
        userId: USER_ID,
        identityPublicKey: 'idk',
        deviceName: 'laptop',
        platform: 'web',
        supportsSignal: true,
      },
    ]);
    mockNegotiate.mockResolvedValue({
      protocol: 'signal',
      totalActiveDevices: 1,
      signalCapableDevices: 1,
      blockingDevices: [],
    });

    const res = await request(makeApp()).get(`/conversations/${CONVERSATION_ID}/devices`);

    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('signal');
    expect(res.body.devices[0].supportsSignal).toBe(true);
  });
});

// ── Send-path enforcement ─────────────────────────────────────────────────────

describe('POST /messages — protocol enforcement', () => {
  const body = {
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    contentType: 'text',
    ciphertext: 'body-ciphertext',
    envelopes: [{ recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env-ciphertext' }],
  };

  function setupInsertTransaction() {
    const envelopeValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([{ id: MESSAGE_ID, conversationId: CONVERSATION_ID }]),
          }),
        })
        .mockReturnValue({ values: envelopeValues }),
      query: {
        devices: {
          findMany: vi.fn().mockResolvedValue([{ id: RECIPIENT_DEVICE_ID, userId: 'user-2' }]),
        },
      },
    };
    mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    return envelopeValues;
  }

  beforeEach(() => {
    mockMessageFindFirst.mockResolvedValue(undefined);
    mockCheckEnvelopeProtocols.mockResolvedValue({ ok: true, negotiated: 'sealed_box' });
  });

  it('defaults an envelope with no protocol to sealed box', async () => {
    const envelopeValues = setupInsertTransaction();

    const res = await request(makeApp()).post('/messages').send(body);

    expect(res.status).toBe(201);
    expect(mockCheckEnvelopeProtocols).toHaveBeenCalledWith(CONVERSATION_ID, [
      { recipientDeviceId: RECIPIENT_DEVICE_ID, protocol: 'sealed_box' },
    ]);
    expect(envelopeValues).toHaveBeenCalledWith([
      expect.objectContaining({ protocol: 'sealed_box' }),
    ]);
  });

  it('persists the protocol a Signal envelope declares', async () => {
    mockCheckEnvelopeProtocols.mockResolvedValue({ ok: true, negotiated: 'signal' });
    const envelopeValues = setupInsertTransaction();

    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...body,
        envelopes: [
          { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'signal' },
        ],
      });

    expect(res.status).toBe(201);
    expect(envelopeValues).toHaveBeenCalledWith([expect.objectContaining({ protocol: 'signal' })]);
  });

  it('returns 400 when a Signal envelope targets a Phase-1 device', async () => {
    mockCheckEnvelopeProtocols.mockResolvedValue({
      ok: false,
      code: 400,
      error: 'Signal envelope addressed to a device that does not support Signal',
      negotiated: 'sealed_box',
      offendingDeviceIds: [RECIPIENT_DEVICE_ID],
    });

    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...body,
        envelopes: [
          { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'signal' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.negotiatedProtocol).toBe('sealed_box');
    expect(res.body.offendingDeviceIds).toEqual([RECIPIENT_DEVICE_ID]);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 409 for a sealed-box downgrade after the cutover', async () => {
    mockCheckEnvelopeProtocols.mockResolvedValue({
      ok: false,
      code: 409,
      error: 'This conversation has cut over to Signal',
      negotiated: 'signal',
      offendingDeviceIds: [RECIPIENT_DEVICE_ID],
    });

    const res = await request(makeApp()).post('/messages').send(body);

    expect(res.status).toBe(409);
    expect(res.body.negotiatedProtocol).toBe('signal');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown protocol value at the schema layer', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...body,
        envelopes: [{ recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'pgp' }],
      });

    expect(res.status).toBe(400);
    expect(mockCheckEnvelopeProtocols).not.toHaveBeenCalled();
  });

  it('runs the protocol check only after membership is confirmed', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).post('/messages').send(body);

    expect(res.status).toBe(403);
    expect(mockCheckEnvelopeProtocols).not.toHaveBeenCalled();
  });
});
