/**
 * Tests that GET /conversations/:id/messages surfaces MLS group messages a
 * device has no key for as placeholders rather than as errors (#372).
 *
 * This is the acceptance criterion a newly-linked device depends on: it joins
 * at epoch N, sees everything from N on, and sees the earlier history as
 * explicitly unavailable instead of as a failed decryption.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockMessageFindMany = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockGetConversationEpochWindow = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversations: { findFirst: vi.fn(), findMany: vi.fn() },
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      messages: { findMany: mockMessageFindMany, findFirst: mockMessageFindFirst },
      devices: { findMany: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  conversations: { id: 'id' },
  messages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt' },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
  devices: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  asc: vi.fn((col: unknown) => col),
  count: vi.fn(),
  desc: vi.fn((col: unknown) => col),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  inArray: vi.fn(),
  lt: vi.fn((col: unknown, val: unknown) => ({ op: 'lt', col, val })),
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
vi.mock('../services/mlsGroups.js', () => ({
  getConversationEpochWindow: mockGetConversationEpochWindow,
}));

const DEVICE_ID = 'device-new';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: DEVICE_ID,
    };
    next();
  },
}));

const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

function message(id: string, mlsEpoch: number | null) {
  return {
    id,
    conversationId: 'conv-1',
    senderId: 'user-2',
    ciphertext: `ciphertext-${id}`,
    mlsEpoch,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
});

describe('GET /conversations/:id/messages — MLS epoch visibility', () => {
  it('leaves messages untouched for a conversation with no MLS group', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({ hasGroup: false, window: null });
    mockMessageFindMany.mockResolvedValue([message('m1', null)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages[0].ciphertext).toBe('ciphertext-m1');
    expect(res.body.messages[0].unavailable).toBeUndefined();
  });

  it('returns pre-join epochs as unavailable and post-join epochs intact', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 3, removedAtEpoch: null },
    });
    // Handler returns oldest-first, so this arrives reversed.
    mockMessageFindMany.mockResolvedValue([message('m3', 4), message('m2', 3), message('m1', 1)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    const [oldest, atJoin, afterJoin] = res.body.messages;

    expect(oldest.id).toBe('m1');
    expect(oldest.ciphertext).toBeNull();
    expect(oldest.unavailable).toBe(true);
    expect(oldest.unavailableReason).toBe('mls_no_key_before_join');

    expect(atJoin.id).toBe('m2');
    expect(atJoin.ciphertext).toBe('ciphertext-m2');

    expect(afterJoin.id).toBe('m3');
    expect(afterJoin.ciphertext).toBe('ciphertext-m3');
  });

  it('keeps unavailable messages in the timeline with their metadata', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 3, removedAtEpoch: null },
    });
    mockMessageFindMany.mockResolvedValue([message('m1', 1)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    // The message is a placeholder, not a hole: the client can still render it
    // in the right position with the right sender.
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({
      id: 'm1',
      senderId: 'user-2',
      mlsEpoch: 1,
      unavailable: true,
    });
  });

  it('does not touch non-MLS messages interleaved in an MLS conversation', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 3, removedAtEpoch: null },
    });
    // A system event written before the device joined has no epoch.
    mockMessageFindMany.mockResolvedValue([message('sys', null)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.body.messages[0].ciphertext).toBe('ciphertext-sys');
    expect(res.body.messages[0].unavailable).toBeUndefined();
  });

  it('marks every MLS message unavailable for a device that has not joined yet', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({ hasGroup: true, window: null });
    mockMessageFindMany.mockResolvedValue([message('m1', 4)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages[0].unavailableReason).toBe('mls_not_a_group_member');
  });

  it('stops at the removal epoch for a device that was removed', async () => {
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 1, removedAtEpoch: 4 },
    });
    mockMessageFindMany.mockResolvedValue([message('m2', 4), message('m1', 3)]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    const [before, after] = res.body.messages;
    expect(before.ciphertext).toBe('ciphertext-m1');
    expect(after.ciphertext).toBeNull();
    expect(after.unavailableReason).toBe('mls_no_key_after_removal');
  });
});
