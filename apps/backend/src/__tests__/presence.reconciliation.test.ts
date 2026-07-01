import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cleanupStaleSockets,
  reconcileBoot,
  registerPresenceSocket,
  setOffline,
  unregisterPresenceSocket,
} from '../services/presence.js';

// ── DB mock ────────────────────────────────────────────────────────────────
const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {
    userId: 'userId',
    conversationId: 'conversationId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Redis & Socket mock ────────────────────────────────────────────────────

describe('Presence Reconciliation & Gateway Boot (#221)', () => {
  let mockRedis: any;
  let mockIo: any;
  let mockSocketsJoin: any;
  let mockFetchSockets: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocketsJoin = vi.fn();
    mockFetchSockets = vi.fn().mockResolvedValue([{ id: 'socket-active' }]);

    mockIo = {
      in: vi.fn((sid: string) => ({
        socketsJoin: mockSocketsJoin,
        fetchSockets: () => mockFetchSockets(sid),
      })),
    };

    mockRedis = {
      scan: vi.fn(),
      keys: vi.fn(),
      smembers: vi.fn(),
      srem: vi.fn().mockResolvedValue(1),
      sadd: vi.fn().mockResolvedValue(1),
      scard: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
      hset: vi.fn().mockResolvedValue(1),
      hgetall: vi.fn().mockResolvedValue({ deviceId: 'device-1' }),
      hdel: vi.fn().mockResolvedValue(1),
      hlen: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(true),
    };
  });

  describe('reconcileBoot', () => {
    it('rebuilds room subscriptions from active Redis socket mappings on boot', async () => {
      // redis.scan returns user socket-mapping keys, not device presence hashes.
      mockRedis.scan
        .mockResolvedValueOnce(['10', ['presence:sockets:user-1', 'presence:sockets:user-2']])
        .mockResolvedValueOnce(['0', []]);

      mockRedis.smembers.mockImplementation(async (key: string) => {
        if (key === 'presence:sockets:user-1') return ['socket-1a', 'socket-1b'];
        if (key === 'presence:sockets:user-2') return ['socket-2a'];
        return [];
      });

      mockFindMany.mockImplementation(async ({ where }: { where: { val: string } }) => {
        if (where.val === 'user-1') {
          return [{ conversationId: 'room-alpha' }, { conversationId: 'room-beta' }];
        }
        if (where.val === 'user-2') {
          return [{ conversationId: 'room-gamma' }];
        }
        return [];
      });

      await reconcileBoot(mockIo as never, mockRedis as never);

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(mockFindMany).toHaveBeenCalledTimes(2);

      expect(mockIo.in).toHaveBeenCalledWith('socket-1a');
      expect(mockIo.in).toHaveBeenCalledWith('socket-1b');
      expect(mockIo.in).toHaveBeenCalledWith('socket-2a');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-alpha');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-beta');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-gamma');
    });

    it('falls back to redis.keys if redis.scan throws', async () => {
      mockRedis.scan.mockRejectedValue(new Error('scan not supported'));
      mockRedis.keys.mockResolvedValue(['presence:sockets:user-3']);
      mockRedis.smembers.mockResolvedValue(['socket-3a']);
      mockFindMany.mockResolvedValue([{ conversationId: 'room-delta' }]);

      await reconcileBoot(mockIo as never, mockRedis as never);

      expect(mockRedis.keys).toHaveBeenCalledWith('presence:sockets:*');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-delta');
    });
  });

  describe('cleanupStaleSockets', () => {
    it('removes stale socket IDs from Redis socket mappings and keeps active sockets', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-dead', 'socket-alive']);

      mockFetchSockets.mockImplementation(async (sid: string) => {
        if (sid === 'socket-alive') return [{ id: 'socket-alive' }];
        return [];
      });
      mockRedis.hgetall.mockResolvedValue({ deviceId: 'device-1' });
      mockRedis.scard.mockImplementation(async (key: string) => {
        if (key === 'presence:sockets:user-1') return 1;
        return 0;
      });

      await cleanupStaleSockets(mockIo as never, mockRedis as never, 'user-1');

      expect(mockRedis.srem).toHaveBeenCalledWith('presence:sockets:user-1', 'socket-dead');
      expect(mockRedis.srem).toHaveBeenCalledWith(
        'presence:device_sockets:user-1:device-1',
        'socket-dead',
      );
      expect(mockRedis.srem).not.toHaveBeenCalledWith('presence:sockets:user-1', 'socket-alive');
      expect(mockRedis.del).toHaveBeenCalledWith('presence:socket:socket-dead');
      expect(mockRedis.del).not.toHaveBeenCalledWith('presence:sockets:user-1');
    });

    it('deletes socket mapping key if all sockets were stale and removed', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-dead-1']);
      mockFetchSockets.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({ deviceId: 'device-1' });
      mockRedis.scard.mockResolvedValue(0);

      await cleanupStaleSockets(mockIo as never, mockRedis as never, 'user-2');

      expect(mockRedis.srem).toHaveBeenCalledWith('presence:sockets:user-2', 'socket-dead-1');
      expect(mockRedis.del).toHaveBeenCalledWith('presence:sockets:user-2');
    });

    it('ignores activeSocketId if passed', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-new']);

      await cleanupStaleSockets(mockIo as never, mockRedis as never, 'user-3', 'socket-new');

      expect(mockFetchSockets).not.toHaveBeenCalled();
      expect(mockRedis.srem).not.toHaveBeenCalled();
    });
  });

  describe('socket mapping helpers', () => {
    it('registers a socket without duplicating device-level presence entries', async () => {
      await registerPresenceSocket(mockRedis as never, 'user-1', 'device-1', 'socket-1');

      expect(mockRedis.sadd).toHaveBeenCalledWith('presence:sockets:user-1', 'socket-1');
      expect(mockRedis.sadd).toHaveBeenCalledWith(
        'presence:device_sockets:user-1:device-1',
        'socket-1',
      );
      expect(mockRedis.hset).toHaveBeenCalledWith('presence:socket:socket-1', {
        userId: 'user-1',
        deviceId: 'device-1',
      });
    });

    it('unregisters a socket and reports whether the device has no sockets left', async () => {
      mockRedis.scard.mockImplementation(async (key: string) => {
        if (key === 'presence:device_sockets:user-1:device-1') return 0;
        return 1;
      });

      const deviceHasNoSockets = await unregisterPresenceSocket(
        mockRedis as never,
        'user-1',
        'device-1',
        'socket-1',
      );

      expect(mockRedis.srem).toHaveBeenCalledWith('presence:sockets:user-1', 'socket-1');
      expect(mockRedis.srem).toHaveBeenCalledWith(
        'presence:device_sockets:user-1:device-1',
        'socket-1',
      );
      expect(mockRedis.del).toHaveBeenCalledWith('presence:socket:socket-1');
      expect(deviceHasNoSockets).toBe(true);
    });
  });

  describe('setOffline', () => {
    it('removes device ID and returns true when no devices remain', async () => {
      mockRedis.hlen.mockResolvedValue(0);

      const offline = await setOffline(mockRedis as never, 'user-1', 'device-1');

      expect(mockRedis.hdel).toHaveBeenCalledWith('presence:user:user-1', 'device-1');
      expect(mockRedis.del).toHaveBeenCalledWith('presence:user:user-1');
      expect(offline).toBe(true);
    });

    it('returns false when surviving devices remain', async () => {
      mockRedis.hlen.mockResolvedValue(1);

      const offline = await setOffline(mockRedis as never, 'user-1', 'device-1');

      expect(mockRedis.hdel).toHaveBeenCalledWith('presence:user:user-1', 'device-1');
      expect(mockRedis.del).not.toHaveBeenCalledWith('presence:user:user-1');
      expect(offline).toBe(false);
    });
  });
});
