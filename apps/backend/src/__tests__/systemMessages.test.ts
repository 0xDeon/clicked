/**
 * Tests for the dedicated `messages.system_payload` column (#334).
 *
 * System messages (device add/revoke, membership changes) used to be written
 * as `JSON.stringify({ userId, change })` into `messages.ciphertext` — the
 * same column that holds genuine, opaque E2EE ciphertext. They now write
 * structured metadata to `systemPayload` and leave `ciphertext` null, which
 * a DB check constraint enforces.
 *
 * The Postgres constraint itself can't be exercised here (there is no live
 * database in this environment; all DB access is mocked), so these tests pin
 * the two halves the application controls: the producer writes the right
 * shape, and the read path serialises it without mistaking a null ciphertext
 * for an undecryptable message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { serializeMessage } from '../lib/messages.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSelect = vi.fn();
const mockMemberFindMany = vi.fn();
const mockTransaction = vi.fn();
const mockInsertValues = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst, findMany: vi.fn() },
      conversationMembers: { findMany: mockMemberFindMany },
    },
    update: mockUpdate,
    delete: mockDelete,
    select: mockSelect,
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: { deviceId: 'deviceId' },
  conversationMembers: { userId: 'userId', conversationId: 'conversationId' },
  messages: {},
}));

vi.mock('../lib/redis.js', () => ({ redis: { publish: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../services/deviceRevocation.js', () => ({
  markDeviceRevoked: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => null) }));
vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

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

const CALLER = { userId: 'owner-user-id', deviceId: 'device-1' };

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: typeof CALLER }).auth = CALLER;
    next();
  },
}));

const { devicesRouter } = await import('../routes/devices.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  return app;
}

/** Captures the `.values(...)` argument passed to `tx.insert(messages)`. */
function setupTransactionCapture() {
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const returning = vi.fn().mockResolvedValue([{ id: 'system-message-1' }]);
    mockInsertValues.mockReturnValue({ returning });
    return fn({ insert: vi.fn().mockReturnValue({ values: mockInsertValues }) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDeviceFindFirst.mockResolvedValue({
    id: 'device-2',
    userId: CALLER.userId,
    identityPublicKey: 'identity-key',
    revokedAt: null,
  });

  // Revocation chains: update().set().where(), delete().where().
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  mockUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) });
  mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  // Active-device count guard: more than one active device so revoke proceeds.
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ total: 3 }]) }),
  });

  // The revoked user is a member of exactly one conversation.
  mockMemberFindMany.mockResolvedValue([
    { conversationId: 'conversation-1', userId: CALLER.userId },
  ]);

  setupTransactionCapture();
});

// ── Producer: emitDeviceChangeEvent ───────────────────────────────────────────

describe('emitDeviceChangeEvent system message payload', () => {
  it('writes { userId, change } to systemPayload and leaves ciphertext null', async () => {
    const res = await request(makeApp()).delete('/devices/device-2');
    expect(res.status).toBe(200);

    // emitDeviceChangeEvent is fire-and-forget (`void`), so wait for the insert.
    await vi.waitFor(() => expect(mockInsertValues).toHaveBeenCalled());

    expect(mockInsertValues).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      senderId: CALLER.userId,
      contentType: 'system',
      ciphertext: null,
      systemPayload: { userId: CALLER.userId, change: 'device_revoked' },
    });

    // Regression guard for #334: the structured metadata must never be
    // stringified back into the E2EE ciphertext column.
    const values = mockInsertValues.mock.calls[0]![0] as { ciphertext: unknown };
    expect(typeof values.ciphertext).not.toBe('string');
  });
});

// ── Read path: serializeMessage ───────────────────────────────────────────────

describe('serializeMessage system messages', () => {
  const base = {
    id: 'message-1',
    senderId: 'user-1',
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
  };

  it('passes systemPayload through and does not mark the message unavailable', () => {
    const payload = { userId: 'user-1', change: 'device_added' };

    const out = serializeMessage({
      ...base,
      contentType: 'system',
      ciphertext: null,
      systemPayload: payload,
    });

    expect(out.ciphertext).toBeNull();
    expect(out.unavailable).toBeUndefined();
    expect(out.systemPayload).toEqual(payload);
  });

  it('never leaks an envelope ciphertext onto a system message', () => {
    const out = serializeMessage({
      ...base,
      contentType: 'system',
      ciphertext: null,
      systemPayload: { userId: 'user-1', change: 'device_revoked' },
      envelopes: [{ ciphertext: 'envelope-ciphertext' }],
    });

    expect(out.ciphertext).toBeNull();
    expect(out.unavailable).toBeUndefined();
  });

  it('still marks a non-system message with no ciphertext or envelope unavailable', () => {
    const out = serializeMessage({
      ...base,
      contentType: 'text',
      ciphertext: null,
    });

    expect(out.ciphertext).toBeNull();
    expect(out.unavailable).toBe(true);
  });

  it('still prefers the envelope ciphertext for non-system messages', () => {
    const out = serializeMessage({
      ...base,
      contentType: 'text',
      ciphertext: 'base-ciphertext',
      envelopes: [{ ciphertext: 'envelope-ciphertext' }],
    });

    expect(out.ciphertext).toBe('envelope-ciphertext');
    expect(out.unavailable).toBeUndefined();
  });

  it('still redacts a deleted message without marking it unavailable', () => {
    const out = serializeMessage({
      ...base,
      contentType: 'text',
      ciphertext: 'base-ciphertext',
      deletedAt: new Date('2026-07-27T11:00:00.000Z'),
    });

    expect(out.ciphertext).toBeNull();
    expect(out.unavailable).toBeUndefined();
  });
});
