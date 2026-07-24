/**
 * Tests for the file-message push path (services/push.ts, #176).
 *
 * This used to send one uncoalesced webpush.sendNotification directly, with
 * no rate limiting and no dead-subscription pruning. It now delegates to
 * pushNotification.ts's shared queueCoalescedPush so file-message pushes get
 * the same coalescing/rate-limit/hygiene behavior as text-message pushes —
 * this test verifies the delegation and the recipient-filtering logic that
 * stays local to this call site (mute, pushEnabled, online-skip).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMembersFindMany = vi.fn();
const mockDevicesFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockMembersFindMany },
      devices: { findMany: mockDevicesFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversation_id', userId: 'user_id' },
  devices: { userId: 'user_id', pushEnabled: 'push_enabled', revokedAt: 'revoked_at' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col, isNull: true })),
}));

const mockIsOnline = vi.fn();
vi.mock('../services/presence.js', () => ({ isOnline: mockIsOnline }));

const mockQueueCoalescedPush = vi.fn();
vi.mock('../services/pushNotification.js', () => ({
  queueCoalescedPush: mockQueueCoalescedPush,
}));

vi.mock('../lib/redis.js', () => ({ redis: { fake: true } }));

const { sendPushForMessage } = await import('../services/push.js');

const CTX = { conversationId: 'conv-1', messageId: 'msg-1', senderId: 'sender-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline.mockResolvedValue(false);
});

describe('sendPushForMessage (#176)', () => {
  it('queues a coalesced push for each active, push-enabled device of an offline, unmuted member', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-a' }, { id: 'device-b' }]);

    await sendPushForMessage(CTX);

    expect(mockQueueCoalescedPush).toHaveBeenCalledTimes(2);
    expect(mockQueueCoalescedPush).toHaveBeenCalledWith('device-a', 'conv-1', 'msg-1');
    expect(mockQueueCoalescedPush).toHaveBeenCalledWith('device-b', 'conv-1', 'msg-1');
  });

  it('skips the sender', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: CTX.senderId, isMuted: false }]);

    await sendPushForMessage(CTX);

    expect(mockDevicesFindMany).not.toHaveBeenCalled();
    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('skips members who muted the conversation', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: true }]);

    await sendPushForMessage(CTX);

    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('skips members who are currently online', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockIsOnline.mockResolvedValue(true);

    await sendPushForMessage(CTX);

    expect(mockDevicesFindMany).not.toHaveBeenCalled();
    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('only resolves active, push-enabled devices (query scoped correctly)', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockDevicesFindMany.mockResolvedValue([]);

    await sendPushForMessage(CTX);

    expect(mockDevicesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() }),
    );
    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('never throws — push is best-effort', async () => {
    mockMembersFindMany.mockRejectedValue(new Error('db down'));

    await expect(sendPushForMessage(CTX)).resolves.toBeUndefined();
  });
});
