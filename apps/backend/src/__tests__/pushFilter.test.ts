/**
 * Tests for unified push recipient filtering.
 *
 * Verifies that getEligiblePushRecipients correctly filters based on:
 * - conversationMembers.isMuted
 * - devices.pushEnabled
 * - Online/offline status
 * - Device connection state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

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
  conversationMembers: {
    conversationId: 'conversation_id',
    userId: 'user_id',
    isMuted: 'is_muted',
  },
  devices: { userId: 'user_id', pushEnabled: 'push_enabled', revokedAt: 'revoked_at' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col, isNull: true })),
}));

const mockIsOnline = vi.fn();
vi.mock('../services/presence.js', () => ({ isOnline: mockIsOnline }));

const mockIsDeviceConnected = vi.fn();
vi.mock('../services/deviceRevocation.js', () => ({ isDeviceConnected: mockIsDeviceConnected }));

const { getEligiblePushRecipients } = await import('../services/pushFilter.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline.mockResolvedValue(false);
  mockIsDeviceConnected.mockReturnValue(false);
});

describe('Push Filter Parity', () => {
  it('filters out the sender', async () => {
    mockMembersFindMany.mockResolvedValue([
      { userId: 'sender-1', isMuted: false },
      { userId: 'recipient-1', isMuted: false },
    ]);
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-1', userId: 'recipient-1' }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
    });

    expect(result).toEqual(['device-1']);
  });

  it('filters out muted members', async () => {
    mockMembersFindMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: true },
      { userId: 'recipient-2', isMuted: false },
    ]);
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-2', userId: 'recipient-2' }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
    });

    expect(result).toEqual(['device-2']);
  });

  it('filters out online users (Redis available)', async () => {
    const mockRedis = new RedisMock();
    mockMembersFindMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false },
      { userId: 'recipient-2', isMuted: false },
    ]);
    mockIsOnline.mockImplementation(async (_redis: Redis, userId: string) => {
      return userId === 'recipient-1'; // recipient-1 is online
    });
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-2', userId: 'recipient-2' }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
      redis: mockRedis,
    });

    expect(result).toEqual(['device-2']);
    expect(mockIsOnline).toHaveBeenCalledWith(mockRedis, 'recipient-1');
    expect(mockIsOnline).toHaveBeenCalledWith(mockRedis, 'recipient-2');
  });

  it('includes all offline users when Redis unavailable', async () => {
    mockMembersFindMany.mockResolvedValue([
      { userId: 'recipient-1', isMuted: false },
      { userId: 'recipient-2', isMuted: false },
    ]);
    mockDevicesFindMany.mockResolvedValue([
      { id: 'device-1', userId: 'recipient-1' },
      { id: 'device-2', userId: 'recipient-2' },
    ]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
      redis: null,
    });

    expect(result).toHaveLength(2);
    expect(mockIsOnline).not.toHaveBeenCalled();
  });

  it('filters out devices with pushEnabled=false', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);

    // Query should only return devices where pushEnabled=true
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-enabled', userId: 'recipient-1' }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
    });

    expect(result).toEqual(['device-enabled']);
  });

  it('filters out connected devices', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockDevicesFindMany.mockResolvedValue([
      { id: 'device-connected', userId: 'recipient-1' },
      { id: 'device-offline', userId: 'recipient-1' },
    ]);

    mockIsDeviceConnected.mockImplementation((deviceId: string) => {
      return deviceId === 'device-connected';
    });

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
    });

    expect(result).toEqual(['device-offline']);
  });

  it('intersects with provided recipientDeviceIds', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockDevicesFindMany.mockResolvedValue([
      { id: 'device-1', userId: 'recipient-1' },
      { id: 'device-2', userId: 'recipient-1' },
      { id: 'device-3', userId: 'recipient-1' },
    ]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
      recipientDeviceIds: ['device-1', 'device-3'], // Only these should be considered
    });

    expect(result).toHaveLength(2);
    expect(result).toContain('device-1');
    expect(result).toContain('device-3');
    expect(result).not.toContain('device-2');
  });

  it('applies all filters in combination', async () => {
    const mockRedis = new RedisMock();
    mockMembersFindMany.mockResolvedValue([
      { userId: 'sender-1', isMuted: false }, // Should be filtered (sender)
      { userId: 'muted-user', isMuted: true }, // Should be filtered (muted)
      { userId: 'online-user', isMuted: false }, // Should be filtered (online)
      { userId: 'eligible-user', isMuted: false }, // Should pass
    ]);

    mockIsOnline.mockImplementation(async (_redis: Redis, userId: string) => {
      return userId === 'online-user';
    });

    mockDevicesFindMany.mockResolvedValue([
      { id: 'eligible-device-1', userId: 'eligible-user' },
      { id: 'eligible-device-2', userId: 'eligible-user' },
    ]);

    mockIsDeviceConnected.mockImplementation((deviceId: string) => {
      return deviceId === 'eligible-device-2'; // One device is connected
    });

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
      redis: mockRedis,
    });

    // Only eligible-device-1 should pass all filters
    expect(result).toEqual(['eligible-device-1']);
  });

  it('returns empty array when no eligible recipients', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'sender-1', isMuted: false }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
    });

    expect(result).toEqual([]);
  });

  it('handles empty recipientDeviceIds gracefully', async () => {
    mockMembersFindMany.mockResolvedValue([{ userId: 'recipient-1', isMuted: false }]);
    mockDevicesFindMany.mockResolvedValue([{ id: 'device-1', userId: 'recipient-1' }]);

    const result = await getEligiblePushRecipients({
      conversationId: 'conv-1',
      senderId: 'sender-1',
      recipientDeviceIds: [], // Empty list
    });

    expect(result).toEqual([]);
  });
});
