/**
 * Tests for the file-message push path (services/push.ts, #176).
 *
 * This used to send one uncoalesced webpush.sendNotification directly, with
 * no rate limiting and no dead-subscription pruning, and it resolved
 * recipients with its own bespoke query. It now does neither: recipient
 * resolution goes through the shared `getEligiblePushRecipients` filter (the
 * same one `dispatchOfflinePush` uses, so mute/pushEnabled/online rules cannot
 * drift between the two paths), and delivery goes through the shared
 * `queueCoalescedPush` so file messages get the same coalescing window,
 * per-device rate limit and pruning hygiene as text messages.
 *
 * The filtering rules themselves are covered by pushFilter.test.ts; this file
 * covers the wiring — that push.ts delegates to both, passes the right
 * arguments, and never throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetEligiblePushRecipients = vi.fn();
vi.mock('../services/pushFilter.js', () => ({
  getEligiblePushRecipients: mockGetEligiblePushRecipients,
}));

const mockQueueCoalescedPush = vi.fn();
vi.mock('../services/pushNotification.js', () => ({
  queueCoalescedPush: mockQueueCoalescedPush,
}));

const fakeRedis = { fake: true };
vi.mock('../lib/redis.js', () => ({
  get redis() {
    return fakeRedis;
  },
}));

const { sendPushForMessage } = await import('../services/push.js');

const CTX = { conversationId: 'conv-1', messageId: 'msg-1', senderId: 'sender-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEligiblePushRecipients.mockResolvedValue([]);
});

describe('sendPushForMessage (#176)', () => {
  it('queues a coalesced push for every eligible recipient device', async () => {
    mockGetEligiblePushRecipients.mockResolvedValue(['device-a', 'device-b']);

    await sendPushForMessage(CTX);

    expect(mockQueueCoalescedPush).toHaveBeenCalledTimes(2);
    expect(mockQueueCoalescedPush).toHaveBeenCalledWith('device-a', 'conv-1', 'msg-1');
    expect(mockQueueCoalescedPush).toHaveBeenCalledWith('device-b', 'conv-1', 'msg-1');
  });

  it('resolves recipients through the shared filter, not a bespoke query', async () => {
    await sendPushForMessage(CTX);

    expect(mockGetEligiblePushRecipients).toHaveBeenCalledWith({
      conversationId: CTX.conversationId,
      senderId: CTX.senderId,
      redis: fakeRedis,
    });
  });

  it('sends nothing when the filter returns no eligible devices', async () => {
    mockGetEligiblePushRecipients.mockResolvedValue([]);

    await sendPushForMessage(CTX);

    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('never throws — push is best-effort', async () => {
    mockGetEligiblePushRecipients.mockRejectedValue(new Error('db down'));

    await expect(sendPushForMessage(CTX)).resolves.toBeUndefined();
    expect(mockQueueCoalescedPush).not.toHaveBeenCalled();
  });

  it('does not let one failing queue call abort the rest', async () => {
    mockGetEligiblePushRecipients.mockResolvedValue(['device-a', 'device-b']);
    mockQueueCoalescedPush.mockImplementationOnce(() => {
      throw new Error('queue exploded');
    });

    await expect(sendPushForMessage(CTX)).resolves.toBeUndefined();
  });
});
