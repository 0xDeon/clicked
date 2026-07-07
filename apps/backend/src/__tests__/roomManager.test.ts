import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindFirst, findMany: mockFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Room Manager', () => {
  let mockSocket: any;
  let mockIo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = {
      auth: {
        userId: 'user-123',
        deviceId: 'device-456',
      },
      join: vi.fn().mockResolvedValue(undefined),
      rooms: new Set(),
    };

    mockIo = {
      fetchSockets: vi.fn().mockResolvedValue([]),
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    // Mock successful membership check
    mockFindFirst.mockResolvedValue({ conversationId: 'conversation-789', userId: 'user-123' });
    mockFindMany.mockResolvedValue([
      { conversationId: 'conversation-789' },
      { conversationId: 'conversation-790' },
    ]);
  });

  it('should generate correct room names', async () => {
    const { conversationRoom, userRoom } = await import('../services/roomManager.js');

    expect(conversationRoom('conversation-789')).toBe('room:conversation:conversation-789');
    expect(userRoom('user-123')).toBe('room:user:user-123');
  });

  it('should join conversation room with membership validation', async () => {
    const { joinConversationRoom } = await import('../services/roomManager.js');

    await joinConversationRoom(mockSocket, 'conversation-789');

    // Verify membership validation
    expect(mockFindFirst).toHaveBeenCalled();

    // Verify room join
    expect(mockSocket.join).toHaveBeenCalledWith('room:conversation:conversation-789');
  });

  it('should reject conversation room join without membership', async () => {
    const { joinConversationRoom } = await import('../services/roomManager.js');

    // Mock no membership
    mockFindFirst.mockResolvedValue(null);

    await expect(joinConversationRoom(mockSocket, 'conversation-789')).rejects.toThrow(
      'Not a member of this conversation',
    );

    expect(mockSocket.join).not.toHaveBeenCalled();
  });

  it('should join user room', async () => {
    const { joinUserRoom } = await import('../services/roomManager.js');

    joinUserRoom(mockSocket);

    expect(mockSocket.join).toHaveBeenCalledWith('room:user:user-123');
  });

  it('should emit typing indicators to conversation room', async () => {
    const { emitTypingIndicator } = await import('../services/roomManager.js');

    emitTypingIndicator(mockIo, 'conversation-789', 'user-123', 'device-456');

    expect(mockIo.to).toHaveBeenCalledWith('room:conversation:conversation-789');
    expect(mockIo.emit).toHaveBeenCalledWith('typing_start', {
      conversationId: 'conversation-789',
      userId: 'user-123',
      deviceId: 'device-456',
    });
  });

  it('should emit presence updates to conversation room', async () => {
    const { emitPresenceUpdate } = await import('../services/roomManager.js');

    emitPresenceUpdate(mockIo, 'conversation-789', 'user-123', true, Date.now());

    expect(mockIo.to).toHaveBeenCalledWith('room:conversation:conversation-789');
    expect(mockIo.emit).toHaveBeenCalledWith('presence_update', {
      userId: 'user-123',
      online: true,
      status: 'online',
      lastSeen: expect.any(Number),
    });
  });

  it('should emit cross-device events to user room', async () => {
    const { emitCrossDeviceEvent } = await import('../services/roomManager.js');

    const eventData = { type: 'settings_updated', settings: { theme: 'dark' } };
    emitCrossDeviceEvent(mockIo, 'user-123', 'settings_updated', eventData);

    expect(mockIo.to).toHaveBeenCalledWith('room:user:user-123');
    expect(mockIo.emit).toHaveBeenCalledWith('cross_device_event', {
      type: 'settings_updated',
      userId: 'user-123',
      data: eventData,
      timestamp: expect.any(String),
    });
  });

  it('should validate conversation membership', async () => {
    const { validateConversationMembership } = await import('../services/roomManager.js');

    const hasMembership = await validateConversationMembership('user-123', 'conversation-789');
    expect(hasMembership).toBe(true);

    // Test without membership
    mockFindFirst.mockResolvedValue(null);
    const noMembership = await validateConversationMembership('user-123', 'conversation-789');
    expect(noMembership).toBe(false);
  });

  it('should rebuild rooms after restart', async () => {
    const { rebuildRoomsAfterRestart } = await import('../services/roomManager.js');

    // Mock sockets
    const mockSockets = [
      {
        auth: { userId: 'user-123', deviceId: 'device-456' },
        join: vi.fn().mockResolvedValue(undefined),
      },
      {
        auth: { userId: 'user-124', deviceId: 'device-457' },
        join: vi.fn().mockResolvedValue(undefined),
      },
    ];

    mockIo.fetchSockets.mockResolvedValue(mockSockets);

    await rebuildRoomsAfterRestart(mockIo);

    // Verify each socket joined user room
    expect(mockSockets[0].join).toHaveBeenCalledWith('room:user:user-123');
    expect(mockSockets[1].join).toHaveBeenCalledWith('room:user:user-124');

    // Verify conversation rooms were joined (mockFindMany returns conversations)
    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });
});
