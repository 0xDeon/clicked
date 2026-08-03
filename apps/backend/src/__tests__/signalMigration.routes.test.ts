/**
 * Tests for the Phase-1 → Signal migration send path (#364).
 *
 * Capability advertisement rides on the existing `devices.capabilities`
 * document (set at registration and updated by re-verifying), and per-device
 * negotiation is already surfaced by `GET /conversations/:id/devices`. What is
 * specific to the migration, and tested here, is `POST /messages`:
 *   - each envelope's declared protocol is enforced before anything persists
 *   - the protocol actually used is recorded on the envelope row
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockTransaction = vi.fn();
const mockCheckEnvelopeProtocols = vi.fn();
const mockInsertMessageEnvelopes = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      messages: { findFirst: mockMessageFindFirst },
      devices: { findMany: vi.fn(), findFirst: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  messages: { id: 'id' },
  messageEnvelopes: {},
  devices: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  inArray: vi.fn(),
}));

vi.mock('../lib/conversationCache.js', () => ({ invalidateConversationCaches: vi.fn() }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));
vi.mock('../services/fileCleanup.js', () => ({ softDeleteFile: vi.fn() }));
vi.mock('../lib/messageFanout.js', () => ({
  insertMessageEnvelopes: mockInsertMessageEnvelopes,
}));
vi.mock('../services/e2eeProtocol.js', () => ({
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

const { messagesRouter } = await import('../routes/messages.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/messages', messagesRouter);
  return app;
}

const BODY = {
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  contentType: 'text',
  ciphertext: 'body-ciphertext',
  envelopes: [{ recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env-ciphertext' }],
};

function setupInsertTransaction() {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: MESSAGE_ID, conversationId: CONVERSATION_ID }]),
      }),
    }),
  };
  mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockMemberFindMany.mockResolvedValue([{ userId: USER_ID }]);
  mockMessageFindFirst.mockResolvedValue(undefined);
  mockCheckEnvelopeProtocols.mockResolvedValue({ ok: true });
  mockInsertMessageEnvelopes.mockResolvedValue([RECIPIENT_DEVICE_ID]);
  setupInsertTransaction();
});

describe('POST /messages — protocol enforcement (#364)', () => {
  it('defaults an envelope with no protocol to sealed box', async () => {
    const res = await request(makeApp()).post('/messages').send(BODY);

    expect(res.status).toBe(201);
    expect(mockCheckEnvelopeProtocols).toHaveBeenCalledWith(DEVICE_ID, [
      { recipientDeviceId: RECIPIENT_DEVICE_ID, protocol: 'sealed_box' },
    ]);
  });

  it('passes a declared Signal protocol through to the check', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...BODY,
        envelopes: [
          { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'signal' },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockCheckEnvelopeProtocols).toHaveBeenCalledWith(DEVICE_ID, [
      { recipientDeviceId: RECIPIENT_DEVICE_ID, protocol: 'signal' },
    ]);
  });

  it('persists the declared protocol on the envelope row', async () => {
    await request(makeApp())
      .post('/messages')
      .send({
        ...BODY,
        envelopes: [
          { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'signal' },
        ],
      });

    const [, , envelopes] = mockInsertMessageEnvelopes.mock.calls[0]!;
    expect(envelopes).toEqual([
      expect.objectContaining({ recipientDeviceId: RECIPIENT_DEVICE_ID, protocol: 'signal' }),
    ]);
  });

  it('returns 400 with the violations when an envelope is undecryptable', async () => {
    const violations = [
      {
        recipientDeviceId: RECIPIENT_DEVICE_ID,
        declared: 'signal',
        expected: 'sealed_box',
        reason: 'unsupported_by_recipient',
      },
    ];
    mockCheckEnvelopeProtocols.mockResolvedValue({
      ok: false,
      code: 400,
      error: 'Envelope protocol is not supported by the recipient device',
      violations,
    });

    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...BODY,
        envelopes: [
          { recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'signal' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.violations).toEqual(violations);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 409 on a downgrade and persists nothing', async () => {
    mockCheckEnvelopeProtocols.mockResolvedValue({
      ok: false,
      code: 409,
      error: 'Envelope protocol is weaker than both devices support',
      violations: [
        {
          recipientDeviceId: RECIPIENT_DEVICE_ID,
          declared: 'sealed_box',
          expected: 'signal',
          reason: 'downgrade',
        },
      ],
    });

    const res = await request(makeApp()).post('/messages').send(BODY);

    expect(res.status).toBe(409);
    expect(res.body.violations[0].reason).toBe('downgrade');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown protocol value at the schema layer', async () => {
    const res = await request(makeApp())
      .post('/messages')
      .send({
        ...BODY,
        envelopes: [{ recipientDeviceId: RECIPIENT_DEVICE_ID, ciphertext: 'env', protocol: 'pgp' }],
      });

    expect(res.status).toBe(400);
    expect(mockCheckEnvelopeProtocols).not.toHaveBeenCalled();
  });

  it('checks membership before running the protocol check', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).post('/messages').send(BODY);

    expect(res.status).toBe(403);
    expect(mockCheckEnvelopeProtocols).not.toHaveBeenCalled();
  });

  it('skips the protocol check for a message with no envelopes', async () => {
    // MLS group messages carry one group ciphertext and no per-device
    // envelopes (#372), so there is nothing to negotiate.
    const res = await request(makeApp()).post('/messages').send({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      contentType: 'text',
      ciphertext: 'group-ciphertext',
      mlsEpoch: 7,
    });

    expect(res.status).toBe(201);
    expect(mockCheckEnvelopeProtocols).not.toHaveBeenCalled();
  });
});
