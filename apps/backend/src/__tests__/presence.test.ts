import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setOnline,
  refreshPresence,
  setOffline,
  markDeviceOffline,
  isOnline,
  scheduleOfflineBroadcast,
  cancelPendingOfflineBroadcast,
  __resetOfflineBroadcastsForTesting,
} from '../services/presence.js';

class FakeRedis {
  public hashes = new Map<string, Record<string, string>>();
  public expires = new Map<string, number>();
  public deleted = new Set<string>();

  async hset(key: string, values: Record<string, string>): Promise<number> {
    const existing = this.hashes.get(key) ?? {};
    const next = { ...existing, ...values };
    this.hashes.set(key, next);
    return Object.keys(values).length;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const existing = this.hashes.get(key);
    if (!existing) {
      return 0;
    }
    let removed = 0;
    for (const field of fields) {
      if (field in existing) {
        delete existing[field];
        removed += 1;
      }
    }
    if (Object.keys(existing).length === 0) {
      this.hashes.delete(key);
    } else {
      this.hashes.set(key, existing);
    }
    return removed;
  }

  async hlen(key: string): Promise<number> {
    return Object.keys(this.hashes.get(key) ?? {}).length;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.expires.set(key, seconds);
    return true;
  }

  async del(key: string): Promise<number> {
    this.deleted.add(key);
    this.hashes.delete(key);
    this.expires.delete(key);
    return 1;
  }
}

describe('presence service', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('tracks a device entry in the per-user hash and refreshes its ttl', async () => {
    await setOnline(redis as any, 'user-1', 'device-1', '1710000000000');

    expect(redis.hashes.get('presence:user:user-1')).toEqual({ 'device-1': '1710000000000' });
    expect(redis.expires.get('presence:user:user-1:device:device-1')).toBe(90);

    await refreshPresence(redis as any, 'user-1', 'device-1', '1710000001000');

    expect(redis.hashes.get('presence:user:user-1')).toEqual({ 'device-1': '1710000001000' });
    expect(redis.expires.get('presence:user:user-1:device:device-1')).toBe(90);
  });

  it('removes a device entry when it disconnects and marks the user offline once all devices are gone', async () => {
    await setOnline(redis as any, 'user-1', 'device-1', '1710000000000');
    await setOnline(redis as any, 'user-1', 'device-2', '1710000000100');

    const firstRemoved = await setOffline(redis as any, 'user-1', 'device-1');
    expect(firstRemoved).toBe(false);
    expect(redis.hashes.get('presence:user:user-1')).toEqual({ 'device-2': '1710000000100' });

    const secondRemoved = await setOffline(redis as any, 'user-1', 'device-2');
    expect(secondRemoved).toBe(true);
    expect(await isOnline(redis as any, 'user-1')).toBe(false);
  });

  it('removes a single device entry when marked offline', async () => {
    await setOnline(redis as any, 'user-1', 'device-1', '1710000000000');
    await markDeviceOffline(redis as any, 'user-1', 'device-1');

    expect(redis.hashes.get('presence:user:user-1')).toEqual(undefined);
    expect(redis.deleted.has('presence:user:user-1:device:device-1')).toBe(true);
  });
});

describe('presence offline-broadcast debounce (#345)', () => {
  const ORIGINAL_GRACE = process.env.PRESENCE_OFFLINE_GRACE_MS;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetOfflineBroadcastsForTesting();
    vi.useRealTimers();
    if (ORIGINAL_GRACE === undefined) delete process.env.PRESENCE_OFFLINE_GRACE_MS;
    else process.env.PRESENCE_OFFLINE_GRACE_MS = ORIGINAL_GRACE;
  });

  it('does not broadcast if cancelled (reconnect) before the grace window elapses', async () => {
    process.env.PRESENCE_OFFLINE_GRACE_MS = '5000';
    const broadcast = vi.fn();

    scheduleOfflineBroadcast('user-1', broadcast);
    vi.advanceTimersByTime(4999);
    const cancelled = cancelPendingOfflineBroadcast('user-1');

    await vi.runAllTimersAsync();

    expect(cancelled).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts once the grace window fully elapses without a reconnect', async () => {
    process.env.PRESENCE_OFFLINE_GRACE_MS = '5000';
    const broadcast = vi.fn();

    scheduleOfflineBroadcast('user-1', broadcast);
    await vi.advanceTimersByTimeAsync(5000);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(cancelPendingOfflineBroadcast('user-1')).toBe(false);
  });

  it('cancelling with nothing pending is a no-op that reports false', () => {
    expect(cancelPendingOfflineBroadcast('user-with-no-pending-broadcast')).toBe(false);
  });

  it('re-scheduling for the same user replaces (does not stack) the pending broadcast', async () => {
    process.env.PRESENCE_OFFLINE_GRACE_MS = '5000';
    const first = vi.fn();
    const second = vi.fn();

    scheduleOfflineBroadcast('user-1', first);
    vi.advanceTimersByTime(2000);
    scheduleOfflineBroadcast('user-1', second);

    await vi.advanceTimersByTimeAsync(5000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('defaults the grace window to 5000ms when PRESENCE_OFFLINE_GRACE_MS is unset', async () => {
    delete process.env.PRESENCE_OFFLINE_GRACE_MS;
    const broadcast = vi.fn();

    scheduleOfflineBroadcast('user-1', broadcast);
    vi.advanceTimersByTime(4999);
    expect(broadcast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
