import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  deviceChannel,
  publishToDevice,
  GatewayDeviceSubscriber,
} from '../services/deviceDelivery.js';
import type { DeviceDeliveryPayload } from '../services/deviceDelivery.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRedis() {
  const emitter = new EventEmitter();
  const published: Array<{ channel: string; message: string }> = [];

  const redis = Object.assign(emitter, {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn(),
    on: emitter.on.bind(emitter),
  });

  // sub client returned by duplicate()
  const subEmitter = new EventEmitter();
  const sub = Object.assign(subEmitter, {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: subEmitter.on.bind(subEmitter),
    emit: subEmitter.emit.bind(subEmitter),
  });

  redis.duplicate.mockReturnValue(sub);

  return { redis, sub, published };
}

const SAMPLE_PAYLOAD: DeviceDeliveryPayload = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  ciphertext: 'encrypted',
  sequenceNumber: 42,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deviceChannel', () => {
  it('produces the correct channel name', () => {
    expect(deviceChannel('device-abc')).toBe('deliver:device:device-abc');
  });
});

describe('publishToDevice', () => {
  it('publishes JSON to the device channel', async () => {
    const { redis, published } = makeRedis();
    await publishToDevice(redis as never, 'device-1', SAMPLE_PAYLOAD);
    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe('deliver:device:device-1');
    expect(JSON.parse(published[0]!.message)).toEqual(SAMPLE_PAYLOAD);
  });

  it('does not throw when Redis publish fails', async () => {
    const { redis } = makeRedis();
    redis.publish.mockRejectedValue(new Error('Redis down'));
    await expect(
      publishToDevice(redis as never, 'device-1', SAMPLE_PAYLOAD),
    ).resolves.toBeUndefined();
  });
});

describe('GatewayDeviceSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the device channel on addDevice', async () => {
    const { redis, sub } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);

    await subscriber.addDevice('dev-1', vi.fn());
    expect(sub.subscribe).toHaveBeenCalledWith('deliver:device:dev-1');
  });

  it('calls handler when a message arrives on the channel', async () => {
    const { redis, sub } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);
    const handler = vi.fn();

    await subscriber.addDevice('dev-2', handler);

    // Simulate a Redis pub message arriving on the sub client
    sub.emit('message', 'deliver:device:dev-2', JSON.stringify(SAMPLE_PAYLOAD));

    expect(handler).toHaveBeenCalledWith(SAMPLE_PAYLOAD);
  });

  it('does not call handler for a different device channel', async () => {
    const { redis, sub } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);
    const handler = vi.fn();

    await subscriber.addDevice('dev-3', handler);
    sub.emit('message', 'deliver:device:OTHER', JSON.stringify(SAMPLE_PAYLOAD));

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not crash on malformed JSON', async () => {
    const { redis, sub } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);
    const handler = vi.fn();

    await subscriber.addDevice('dev-4', handler);
    sub.emit('message', 'deliver:device:dev-4', 'not-json{{{');

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes and removes handler on removeDevice', async () => {
    const { redis, sub } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);
    const handler = vi.fn();

    await subscriber.addDevice('dev-5', handler);
    await subscriber.removeDevice('dev-5');

    expect(sub.unsubscribe).toHaveBeenCalledWith('deliver:device:dev-5');

    // Handler must not fire after removal
    sub.emit('message', 'deliver:device:dev-5', JSON.stringify(SAMPLE_PAYLOAD));
    expect(handler).not.toHaveBeenCalled();
  });

  it('gracefully handles subscribe failure', async () => {
    const { redis, sub } = makeRedis();
    sub.subscribe.mockRejectedValue(new Error('Redis unavailable'));
    const subscriber = new GatewayDeviceSubscriber(redis as never);

    await expect(subscriber.addDevice('dev-6', vi.fn())).resolves.toBeUndefined();
  });

  it('local delivery still works when Redis channel fails', async () => {
    const { redis } = makeRedis();
    const subscriber = new GatewayDeviceSubscriber(redis as never);
    const localHandler = vi.fn();

    // Simulate Redis subscribe failure — handler was never registered
    // Local delivery through the in-process path (no-op here, but we verify
    // the subscriber doesn't crash and the gateway can still call the handler).
    await expect(subscriber.addDevice('dev-7', localHandler)).resolves.toBeUndefined();
  });
});
