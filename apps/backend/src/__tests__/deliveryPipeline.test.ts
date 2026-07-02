import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conv_id', userId: 'user_id' },
  userDevices: { userId: 'ud_user_id', revokedAt: 'ud_revoked_at', id: 'ud_id' },
  messageEnvelopes: {
    messageId: 'me_msg_id',
    recipientDeviceId: 'me_rcpt_device_id',
    id: 'me_id',
    ciphertext: 'me_ciphertext',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeIo() {
  const emissions: Record<string, { event: string; data: unknown }[]> = {};

  const emitFn = (room: string) =>
    vi.fn((event: string, data: unknown) => {
      emissions[room] ??= [];
      emissions[room]!.push({ event, data });
    });

  const roomEmit: Record<string, ReturnType<typeof vi.fn>> = {};

  const io = {
    to: vi.fn((room: string) => {
      roomEmit[room] ??= emitFn(room);
      return { emit: roomEmit[room] };
    }),
    emissions,
    roomEmit,
  };
  return io;
}

function baseMessage() {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-a',
    senderDeviceId: 'dev-a',
    contentType: 'text/plain',
    sequenceNumber: 1,
    createdAt: new Date('2024-01-01'),
    deletedAt: null,
    ciphertext: 'base-ciphertext',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('deliverMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default chained select builder
    mockWhere.mockResolvedValue([]);
    mockFrom.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
  });

  it('emits message_envelope to each active device that has an envelope', async () => {
    const members = [{ userId: 'user-b' }];
    const activeDevices = [{ id: 'dev-b', userId: 'user-b' }];
    const envelopes = [
      { id: 'env-1', recipientDeviceId: 'dev-b', ciphertext: 'encrypted-for-dev-b' },
    ];

    mockWhere
      .mockResolvedValueOnce(members)
      .mockResolvedValueOnce(activeDevices)
      .mockResolvedValueOnce(envelopes);

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    // Device-scoped emission
    expect(io.to).toHaveBeenCalledWith('device:dev-b');
    const deviceEmit = io.roomEmit['device:dev-b'];
    expect(deviceEmit).toHaveBeenCalledWith(
      'message_envelope',
      expect.objectContaining({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        envelopeId: 'env-1',
        ciphertext: 'encrypted-for-dev-b',
      }),
    );
  });

  it('emits new_message to conversation room without ciphertext', async () => {
    const members = [{ userId: 'user-b' }];
    const activeDevices = [{ id: 'dev-b', userId: 'user-b' }];
    const envelopes = [
      { id: 'env-1', recipientDeviceId: 'dev-b', ciphertext: 'encrypted-for-dev-b' },
    ];

    mockWhere
      .mockResolvedValueOnce(members)
      .mockResolvedValueOnce(activeDevices)
      .mockResolvedValueOnce(envelopes);

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    expect(io.to).toHaveBeenCalledWith('conv-1');
    const roomEmit = io.roomEmit['conv-1'];
    expect(roomEmit).toHaveBeenCalledWith(
      'new_message',
      expect.objectContaining({ id: 'msg-1', ciphertext: null }),
    );
  });

  it('skips devices that have no envelope', async () => {
    const members = [{ userId: 'user-b' }, { userId: 'user-c' }];
    const activeDevices = [
      { id: 'dev-b', userId: 'user-b' },
      { id: 'dev-c', userId: 'user-c' },
    ];
    // Only dev-b has an envelope; dev-c does not.
    const envelopes = [{ id: 'env-1', recipientDeviceId: 'dev-b', ciphertext: 'ct-b' }];

    mockWhere
      .mockResolvedValueOnce(members)
      .mockResolvedValueOnce(activeDevices)
      .mockResolvedValueOnce(envelopes);

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    expect(io.to).toHaveBeenCalledWith('device:dev-b');
    expect(io.to).not.toHaveBeenCalledWith('device:dev-c');
  });

  it('only emits new_message to room when no active devices exist', async () => {
    const members = [{ userId: 'user-b' }];

    mockWhere.mockResolvedValueOnce(members).mockResolvedValueOnce([]); // no active devices

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    // Should emit new_message as fallback
    expect(io.to).toHaveBeenCalledWith('conv-1');
    expect(io.roomEmit['conv-1']).toHaveBeenCalledWith('new_message', expect.anything());
    // No device-scoped emission
    expect(Object.keys(io.roomEmit)).not.toContain('device:dev-b');
  });

  it('returns early when there are no members', async () => {
    mockWhere.mockResolvedValueOnce([]); // no members

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    expect(io.to).not.toHaveBeenCalled();
  });

  it('delivers envelopes to multiple devices independently', async () => {
    const members = [{ userId: 'user-b' }, { userId: 'user-c' }];
    const activeDevices = [
      { id: 'dev-b', userId: 'user-b' },
      { id: 'dev-c', userId: 'user-c' },
    ];
    const envelopes = [
      { id: 'env-1', recipientDeviceId: 'dev-b', ciphertext: 'ct-b' },
      { id: 'env-2', recipientDeviceId: 'dev-c', ciphertext: 'ct-c' },
    ];

    mockWhere
      .mockResolvedValueOnce(members)
      .mockResolvedValueOnce(activeDevices)
      .mockResolvedValueOnce(envelopes);

    const io = makeIo();
    const { deliverMessage } = await import('../services/deliveryPipeline.js');

    await deliverMessage(io as never, baseMessage() as never, 'conv-1');

    expect(io.roomEmit['device:dev-b']).toHaveBeenCalledWith(
      'message_envelope',
      expect.objectContaining({ ciphertext: 'ct-b', envelopeId: 'env-1' }),
    );
    expect(io.roomEmit['device:dev-c']).toHaveBeenCalledWith(
      'message_envelope',
      expect.objectContaining({ ciphertext: 'ct-c', envelopeId: 'env-2' }),
    );
  });
});
