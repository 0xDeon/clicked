import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockQuery = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindFirst, findMany: mockQuery },
      messages: { findFirst: mockFindFirst },
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
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockIo = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    mockSocket = {
      auth: {
        userId: 'user-123',
        deviceId: 'device-456',
      },
      emit: vi.fn(),
      rooms: new Set(['conversation-789']),
    };

    // Mock successful membership check
    mockFindFirst.mockResolvedValue({ conversationId: 'conversation-789', userId: 'user-123' });
    
    // Mock message find
    mockFindFirst.mockResolvedValueOnce({ id: 'message-abc', senderId: 'sender-999', conversationId: 'conversation-789' });
    
    // Mock update success
    mockUpdate.mockResolvedValue({ rowCount: 1 });
    
    // Mock active devices query
    mockSelect.mockResolvedValue([
      { id: 'device-456' },
      { id: 'device-457' },
    ]);
    
    // Mock envelopes query
    mockSelect.mockResolvedValueOnce([
      { recipientDeviceId: 'device-456', deliveredAt: new Date() },
      { recipientDeviceId: 'device-457', deliveredAt: null },
    ]);
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
      'conversation-789'
    );

    // Verify database update was called
    expect(mockUpdate).toHaveBeenCalled();

    // Verify room-based emission
    expect(mockIo.to).toHaveBeenCalledWith('room:conversation:conversation-789');
    expect(mockIo.emit).toHaveBeenCalledWith('device_delivery_receipt', expect.objectContaining({
      conversationId: 'conversation-789',
      messageId: 'message-abc',
      recipientUserId: 'user-123',
      recipientDeviceId: 'device-456',
    }));
  });

  it('should validate isMessageFullyDeliveredToUser correctly', async () => {
    const { isMessageFullyDeliveredToUser } = await import('../services/deliveryAggregation.js');
    
    // First device delivered, second not delivered
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([{ id: 'device-456' }, { id: 'device-457' }]) // active devices
      .mockResolvedValueOnce([
        { recipientDeviceId: 'device-456', deliveredAt: new Date() },
        { recipientDeviceId: 'device-457', deliveredAt: null },
      ]); // envelopes
    
    const notFullyDelivered = await isMessageFullyDeliveredToUser('message-abc', 'user-123');
    expect(notFullyDelivered).toBe(false);

    // Both devices delivered
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([{ id: 'device-456' }, { id: 'device-457' }]) // active devices
      .mockResolvedValueOnce([
        { recipientDeviceId: 'device-456', deliveredAt: new Date() },
        { recipientDeviceId: 'device-457', deliveredAt: new Date() },
      ]); // envelopes
    
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
      'conversation-789'
    );

    const firstCallCount = mockUpdate.mock.calls.length;

    // Second call with same parameters
    await handleDeviceDeliveryReceipt(
      mockIo,
      null,
      'message-abc',
      'device-456',
      'user-123',
      'conversation-789'
    );

    // Should have same number of update calls (idempotent)
    expect(mockUpdate.mock.calls.length).toBe(firstCallCount);
  });
});