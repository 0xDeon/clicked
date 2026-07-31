import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { isReplay, getReplayProtectionRedisKey, markSeen } from './replay-protection.service.js';

describe('ReplayProtectionService', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    // Reset environment variable to default
    delete process.env['REPLAY_PROTECTION_TTL_SECONDS'];
  });

  afterEach(async () => {
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  describe('isReplay', () => {
    it('should return false for first occurrence of eventId (not a replay)', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      const result = await isReplay(redis, deviceId, eventId);

      expect(result).toBe(false);
    });

    it('should return true for second occurrence of same eventId within TTL (is a replay)', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      // First occurrence
      const first = await isReplay(redis, deviceId, eventId);
      expect(first).toBe(false);

      // Second occurrence (replay)
      const second = await isReplay(redis, deviceId, eventId);
      expect(second).toBe(true);
    });

    it('should treat same eventId from different deviceId as distinct (not a replay)', async () => {
      const eventId = 'event-1';

      const firstDevice = await isReplay(redis, 'device-1', eventId);
      expect(firstDevice).toBe(false);

      const secondDevice = await isReplay(redis, 'device-2', eventId);
      expect(secondDevice).toBe(false);
    });

    it('should treat different eventId from same deviceId as distinct (not a replay)', async () => {
      const deviceId = 'device-1';

      const firstEvent = await isReplay(redis, deviceId, 'event-1');
      expect(firstEvent).toBe(false);

      const secondEvent = await isReplay(redis, deviceId, 'event-2');
      expect(secondEvent).toBe(false);
    });

    it('should allow same eventId after TTL expires', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      // Set short TTL for testing
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '1';

      // First occurrence
      const first = await isReplay(redis, deviceId, eventId);
      expect(first).toBe(false);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // After TTL expiration, same eventId should be allowed
      const afterExpiry = await isReplay(redis, deviceId, eventId);
      expect(afterExpiry).toBe(false);
    });

    it('should gracefully handle missing Redis (fail open)', async () => {
      const result = await isReplay(null, 'device-1', 'event-1');

      // Should return false (allow the event through)
      expect(result).toBe(false);
    });

    it('should skip check for missing deviceId (fail open)', async () => {
      const result = await isReplay(redis, '', 'event-1');

      expect(result).toBe(false);
    });

    it('should skip check for missing eventId (fail open)', async () => {
      const result = await isReplay(redis, 'device-1', '');

      expect(result).toBe(false);
    });

    it('should skip check for null deviceId (fail open)', async () => {
      const result = await isReplay(redis, null as any, 'event-1');

      expect(result).toBe(false);
    });

    it('should skip check for null eventId (fail open)', async () => {
      const result = await isReplay(redis, 'device-1', null as any);

      expect(result).toBe(false);
    });

    it('should skip check for whitespace-only deviceId', async () => {
      const result = await isReplay(redis, '   ', 'event-1');

      expect(result).toBe(false);
    });

    it('should skip check for whitespace-only eventId', async () => {
      const result = await isReplay(redis, 'device-1', '   ');

      expect(result).toBe(false);
    });

    it('should use default TTL of 300 seconds when env var not set', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      // First occurrence — should be marked with default TTL
      const first = await isReplay(redis, deviceId, eventId);
      expect(first).toBe(false);

      // Check TTL in Redis
      const key = getReplayProtectionRedisKey(deviceId, eventId);
      const ttl = await redis.ttl(key);

      // TTL should be close to 300 (allowing small variance)
      expect(ttl).toBeGreaterThan(290);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('should use custom TTL from environment variable', async () => {
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '120';

      const deviceId = 'device-1';
      const eventId = 'event-1';

      const first = await isReplay(redis, deviceId, eventId);
      expect(first).toBe(false);

      const key = getReplayProtectionRedisKey(deviceId, eventId);
      const ttl = await redis.ttl(key);

      // TTL should be close to 120
      expect(ttl).toBeGreaterThan(110);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it('should validate TTL is between 1 and 86400 seconds', async () => {
      // Invalid: below 1
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '0';
      const deviceId = 'device-1';
      const eventId = 'event-1';
      const below1 = await isReplay(redis, deviceId, eventId);
      // Should use default TTL instead
      const keyBelow = getReplayProtectionRedisKey(deviceId, eventId);
      const ttlBelow = await redis.ttl(keyBelow);
      expect(ttlBelow).toBeGreaterThan(290);

      await redis.flushdb();

      // Invalid: above 86400
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '100000';
      const eventId2 = 'event-2';
      const above = await isReplay(redis, deviceId, eventId2);
      // Should use default TTL instead
      const keyAbove = getReplayProtectionRedisKey(deviceId, eventId2);
      const ttlAbove = await redis.ttl(keyAbove);
      expect(ttlAbove).toBeGreaterThan(290);

      await redis.flushdb();

      // Invalid: non-integer
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = 'invalid';
      const eventId3 = 'event-3';
      const invalid = await isReplay(redis, deviceId, eventId3);
      // Should use default TTL instead
      const keyInvalid = getReplayProtectionRedisKey(deviceId, eventId3);
      const ttlInvalid = await redis.ttl(keyInvalid);
      expect(ttlInvalid).toBeGreaterThan(290);
    });

    it('should gracefully handle Redis errors', async () => {
      const errorRedis = {
        set: vi.fn().mockRejectedValueOnce(new Error('Redis connection failed')),
      } as any;

      // Spy on console.warn to verify error is logged
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await isReplay(errorRedis, 'device-1', 'event-1');

      // Should return false (fail open)
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('getReplayProtectionRedisKey', () => {
    it('should return correct Redis key format', () => {
      const key = getReplayProtectionRedisKey('device-1', 'event-1');

      expect(key).toBe('replay:device-1:event-1');
    });

    it('should include special characters in key', () => {
      const key = getReplayProtectionRedisKey('device-abc-123', 'event-uuid-456');

      expect(key).toBe('replay:device-abc-123:event-uuid-456');
    });
  });

  describe('markSeen', () => {
    it('should explicitly mark an event as seen', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      await markSeen(redis, deviceId, eventId);

      // Verify the key exists
      const key = getReplayProtectionRedisKey(deviceId, eventId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);
    });

    it('should set TTL when marking as seen', async () => {
      const deviceId = 'device-1';
      const eventId = 'event-1';

      await markSeen(redis, deviceId, eventId);

      const key = getReplayProtectionRedisKey(deviceId, eventId);
      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(290);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('should gracefully handle missing Redis', async () => {
      // Should not throw
      await expect(markSeen(null, 'device-1', 'event-1')).resolves.not.toThrow();
    });

    it('should skip if deviceId is empty', async () => {
      await markSeen(redis, '', 'event-1');

      // Verify no key was created
      const keys = await redis.keys('replay:*');
      expect(keys).toHaveLength(0);
    });

    it('should skip if eventId is empty', async () => {
      await markSeen(redis, 'device-1', '');

      // Verify no key was created
      const keys = await redis.keys('replay:*');
      expect(keys).toHaveLength(0);
    });

    it('should gracefully handle Redis errors', async () => {
      const errorRedis = {
        setex: vi.fn().mockRejectedValueOnce(new Error('Redis error')),
      } as any;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw
      await expect(markSeen(errorRedis, 'device-1', 'event-1')).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
