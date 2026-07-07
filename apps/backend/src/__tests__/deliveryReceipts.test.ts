import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockEnvelopeFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockQuery = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindFirst, findMany: mockQuery },
      messages: { findFirst: mockFindFirst },
      messageEnvelopes: { findFirst: mockEnvelopeFindFirst },
    },
    select: mockSelect,
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
  messages: {},
  messageEnvelopes: {},
  userDevices: {},
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
}));

vi.mock('../services/resumeStream.js', () => ({
  publishEphemeral: vi.fn().mockResolvedValue(undefined),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Delivery Receipts', () => {
  let mockIo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockIo = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };
    mockIo.volatile = mockIo;

    // Mock successful membership check
    mockFindFirst.mockResolvedValue({ conversationId: 'conversation-789', userId: 'user-123' });

    // Mock envelope not yet delivered by default (allows the update to proceed)
    mockEnvelopeFindFirst.mockResolvedValue(undefined);

    // Mock message find
    mockFindFirst.mockResolvedValueOnce({
      id: 'message-abc',
      senderId: 'sender-999',
      conversationId: 'conversation-789',
    });

    // Mock update success
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue({ rowCount: 1 }),
    });

    // Each isMessageFullyDeliveredToUser() call issues two selects in order:
    // active devices, then envelopes. Alternate responses so repeated calls
    // (e.g. the idempotency test) keep getting a valid chain.
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount += 1;
      const isEnvelopeQuery = selectCallCount % 2 === 0;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(
          isEnvelopeQuery
            ? [
                { recipientDeviceId: 'device-456', deliveredAt: new Date() },
                { recipientDeviceId: 'device-457', deliveredAt: null },
              ]
            : [{ id: 'device-456' }, { id: 'device-457' }],
        ),
      };
    });
  });

  it('should handle per-device delivery receipt', async () => {
    // Import dynamically after mocks are set up
    const { handleDeviceDeliveryReceipt } = await import('../services/deliveryAggregation.js');

    await handleDeviceDeliveryReceipt(
      mockIo,
      null, // redis
      'message-abc',
      'device-456',
      'user-123',
      'conversation-789',
    );

    // Verify database update was called
    expect(mockUpdate).toHaveBeenCalled();

    // Verify room-based emission
    expect(mockIo.to).toHaveBeenCalledWith('room:conversation:conversation-789');
    expect(mockIo.emit).toHaveBeenCalledWith(
      'device_delivery_receipt',
      expect.objectContaining({
        conversationId: 'conversation-789',
        messageId: 'message-abc',
        recipientUserId: 'user-123',
        recipientDeviceId: 'device-456',
      }),
    );
  });

  it('should validate isMessageFullyDeliveredToUser correctly', async () => {
    const { isMessageFullyDeliveredToUser } = await import('../services/deliveryAggregation.js');

    const chainSelect = (result: unknown[]) => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(result),
    });

    // First device delivered, second not delivered
    mockSelect
      .mockReset()
      .mockReturnValueOnce(chainSelect([{ id: 'device-456' }, { id: 'device-457' }])) // active devices
      .mockReturnValueOnce(
        chainSelect([
          { recipientDeviceId: 'device-456', deliveredAt: new Date() },
          { recipientDeviceId: 'device-457', deliveredAt: null },
        ]),
      ); // envelopes

    const notFullyDelivered = await isMessageFullyDeliveredToUser('message-abc', 'user-123');
    expect(notFullyDelivered).toBe(false);

    // Both devices delivered
    mockSelect
      .mockReset()
      .mockReturnValueOnce(chainSelect([{ id: 'device-456' }, { id: 'device-457' }])) // active devices
      .mockReturnValueOnce(
        chainSelect([
          { recipientDeviceId: 'device-456', deliveredAt: new Date() },
          { recipientDeviceId: 'device-457', deliveredAt: new Date() },
        ]),
      ); // envelopes

    const fullyDelivered = await isMessageFullyDeliveredToUser('message-abc', 'user-123');
    expect(fullyDelivered).toBe(true);
  });

  it('should be idempotent for duplicate delivery receipts', async () => {
    const { handleDeviceDeliveryReceipt } = await import('../services/deliveryAggregation.js');

    // First call
    await handleDeviceDeliveryReceipt(
      mockIo,
      null,
      'message-abc',
      'device-456',
      'user-123',
      'conversation-789',
    );

    const firstCallCount = mockUpdate.mock.calls.length;

    // Simulate the envelope now being marked delivered from the first call,
    // so the duplicate receipt short-circuits before touching the DB again.
    mockEnvelopeFindFirst.mockResolvedValueOnce({ deliveredAt: new Date() });

    // Second call with same parameters
    await handleDeviceDeliveryReceipt(
      mockIo,
      null,
      'message-abc',
      'device-456',
      'user-123',
      'conversation-789',
    );

    // Should have same number of update calls (idempotent)
    expect(mockUpdate.mock.calls.length).toBe(firstCallCount);
  });
});
