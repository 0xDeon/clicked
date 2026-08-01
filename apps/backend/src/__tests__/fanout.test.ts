import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMemberFindMany = vi.fn();
const mockDeviceFindMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockMemberFindMany },
      devices: { findMany: mockDeviceFindMany },
    },
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  devices: { userId: 'userId', revokedAt: 'revokedAt', id: 'id' },
  messages: { conversationId: 'conversationId', id: 'id' },
  messageEnvelopes: {
    messageId: 'messageId',
    recipientDeviceId: 'recipientDeviceId',
    recipientUserId: 'recipientUserId',
    ciphertext: 'ciphertext',
    id: 'id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  isNull: vi.fn((col: unknown) => ({ col })),
}));

const { fanoutMessage } = await import('../services/fanout.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fanoutMessage', () => {
  it('persists the message and its envelopes in a single transaction', async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: 'user-alice' }, { userId: 'user-bob' }]);
    mockDeviceFindMany.mockResolvedValue([
      { id: 'device-alice-2', userId: 'user-alice' },
      { id: 'device-bob-1', userId: 'user-bob' },
      { id: 'device-sender', userId: 'user-alice' },
    ]);

    const persistedMessage = {
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'user-alice',
      senderDeviceId: 'device-sender',
      ciphertext: 'hello',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    };

    const messageReturning = vi.fn().mockResolvedValue([persistedMessage]);
    const envelopeValues = vi.fn().mockResolvedValue(undefined);
    const messageValues = vi.fn().mockReturnValue({ returning: messageReturning });
    const insert = vi.fn((table: unknown) => {
      if (table && typeof table === 'object' && 'conversationId' in table) {
        return { values: messageValues };
      }
      return { values: envelopeValues };
    });
    const tx = { insert };
    mockTransaction.mockImplementation(async (cb: (txArg: typeof tx) => unknown) => cb(tx));

    const result = await fanoutMessage(
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderId: 'user-alice',
        senderDeviceId: 'device-sender',
        ciphertext: 'hello',
      },
      'device-sender',
      {
        'device-alice-2': 'cipher-for-alice-2',
        'device-bob-1': 'cipher-for-bob-1',
      },
    );

    expect(result).toEqual({ ok: true, message: persistedMessage });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(messageValues).toHaveBeenCalledWith({
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'user-alice',
      senderDeviceId: 'device-sender',
      ciphertext: 'hello',
    });
    expect(envelopeValues).toHaveBeenCalledWith([
      {
        messageId: 'msg-1',
        recipientDeviceId: 'device-alice-2',
        recipientUserId: 'user-alice',
        ciphertext: 'cipher-for-alice-2',
      },
      {
        messageId: 'msg-1',
        recipientDeviceId: 'device-bob-1',
        recipientUserId: 'user-bob',
        ciphertext: 'cipher-for-bob-1',
      },
    ]);
  });

  it('returns device_set_mismatch without starting a transaction when devices are stale', async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: 'user-alice' }, { userId: 'user-bob' }]);
    mockDeviceFindMany.mockResolvedValue([
      { id: 'device-alice-2', userId: 'user-alice' },
      { id: 'device-bob-1', userId: 'user-bob' },
      { id: 'device-sender', userId: 'user-alice' },
    ]);

    const result = await fanoutMessage(
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        senderId: 'user-alice',
        senderDeviceId: 'device-sender',
        ciphertext: 'hello',
      },
      'device-sender',
      {
        'device-bob-1': 'cipher-for-bob-1',
      },
    );

    expect(result).toEqual({
      ok: false,
      error: 'device_set_mismatch',
      expectedDeviceIds: ['device-alice-2', 'device-bob-1'],
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
