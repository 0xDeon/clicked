/**
 * Tests for services/deviceRevocation.ts (#341)
 *
 * The device↔socket registry used to be an in-process Map, only visible to
 * the local gateway. It's now backed by the same Redis registry presence.ts
 * maintains, so these tests exercise isDeviceConnected and the revocation
 * pub/sub flow against a fake Redis that behaves identically across two
 * independently-constructed "nodes" (i.e. no shared in-process state).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => mockIo,
}));

let mockIo: { sockets: { sockets: Map<string, unknown> } };

class FakeRedis extends EventEmitter {
  private store = new Map<string, Set<string>>();
  private hashes = new Map<string, Record<string, string>>();

  async sadd(key: string, member: string) {
    if (!this.store.has(key)) this.store.set(key, new Set());
    this.store.get(key)!.add(member);
    return 1;
  }

  async srem(key: string, member: string) {
    this.store.get(key)?.delete(member);
    return 1;
  }

  async smembers(key: string) {
    return Array.from(this.store.get(key) ?? []);
  }

  async scard(key: string) {
    return this.store.get(key)?.size ?? 0;
  }

  async del(key: string) {
    this.store.delete(key);
    this.hashes.delete(key);
    return 1;
  }

  async expire() {
    return 1;
  }

  async hset(key: string, fields: Record<string, string>) {
    if (!this.hashes.has(key)) this.hashes.set(key, {});
    Object.assign(this.hashes.get(key)!, fields);
    return 1;
  }

  async hgetall(key: string) {
    return this.hashes.get(key) ?? {};
  }

  async hdel(key: string, ...fields: string[]) {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) {
      if (field in hash) {
        delete hash[field];
        removed += 1;
      }
    }
    return removed;
  }

  async hlen(key: string) {
    return Object.keys(this.hashes.get(key) ?? {}).length;
  }

  async psubscribe() {
    return 1;
  }

  status = 'ready';
}

function makeSocket(id: string, auth: { userId: string; deviceId: string }) {
  const emitted: Array<{ event: string; data: unknown }> = [];
  return {
    id,
    auth,
    emit: vi.fn((event: string, data: unknown) => emitted.push({ event, data })),
    disconnect: vi.fn(),
    emitted,
  };
}

describe('isDeviceConnected — Redis-backed registry (#341)', () => {
  it('returns false when redis is unavailable', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    expect(await isDeviceConnected(null, 'device-1')).toBe(false);
  });

  it('returns false for a device with no registered sockets', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    const redis = new FakeRedis();
    expect(await isDeviceConnected(redis as never, 'device-1')).toBe(false);
  });

  it('returns true once a socket is registered for the device via presence.ts', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    const { registerPresenceSocket } = await import('../services/presence.js');
    const redis = new FakeRedis();

    await registerPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');

    expect(await isDeviceConnected(redis as never, 'device-1')).toBe(true);
  });

  it('is visible across two independently-constructed registry readers sharing the same Redis — simulating cross-node visibility', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    const { registerPresenceSocket } = await import('../services/presence.js');
    const sharedRedis = new FakeRedis();

    // "Node A" registers the connection.
    await registerPresenceSocket(sharedRedis as never, 'user-1', 'device-1', 'socket-on-node-a');

    // "Node B" — a separate isDeviceConnected() call against the same Redis
    // instance — must also see the device as connected, unlike the old
    // in-process Map which only had local visibility.
    expect(await isDeviceConnected(sharedRedis as never, 'device-1')).toBe(true);
  });

  it('returns false again after the only socket unregisters', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    const { registerPresenceSocket, unregisterPresenceSocket } = await import(
      '../services/presence.js'
    );
    const redis = new FakeRedis();

    await registerPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');
    expect(await isDeviceConnected(redis as never, 'device-1')).toBe(true);

    await unregisterPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');
    expect(await isDeviceConnected(redis as never, 'device-1')).toBe(false);
  });

  it('stays true when one of two sockets for the same device disconnects', async () => {
    const { isDeviceConnected } = await import('../services/deviceRevocation.js');
    const { registerPresenceSocket, unregisterPresenceSocket } = await import(
      '../services/presence.js'
    );
    const redis = new FakeRedis();

    await registerPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');
    await registerPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-2');

    await unregisterPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');

    expect(await isDeviceConnected(redis as never, 'device-1')).toBe(true);
  });
});

describe('revocation disconnect flow — no regression from the registry swap (#341)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('disconnects a locally-connected socket when its device is revoked', async () => {
    const { startDeviceRevocationListener, isDeviceRevoked } = await import(
      '../services/deviceRevocation.js'
    );
    const { registerPresenceSocket } = await import('../services/presence.js');
    const redis = new FakeRedis();

    const socket = makeSocket('socket-1', { userId: 'user-1', deviceId: 'device-1' });
    mockIo = { sockets: { sockets: new Map([['socket-1', socket]]) } };

    await registerPresenceSocket(redis as never, 'user-1', 'device-1', 'socket-1');
    await startDeviceRevocationListener(redis as never, redis as never);

    redis.emit('pmessage', 'device_revoked:*', 'device_revoked:device-1', '1');
    await new Promise((r) => setTimeout(r, 10));

    expect(isDeviceRevoked('device-1')).toBe(true);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emitted.some((e) => e.event === 'device_revoked')).toBe(true);
  });

  it('marks the device revoked even when no socket is registered for it', async () => {
    const { startDeviceRevocationListener, isDeviceRevoked } = await import(
      '../services/deviceRevocation.js'
    );
    const redis = new FakeRedis();
    mockIo = { sockets: { sockets: new Map() } };

    await startDeviceRevocationListener(redis as never, redis as never);

    redis.emit('pmessage', 'device_revoked:*', 'device_revoked:device-ghost', '1');
    await new Promise((r) => setTimeout(r, 10));

    expect(isDeviceRevoked('device-ghost')).toBe(true);
  });
});
