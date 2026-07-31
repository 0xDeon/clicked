/**
 * Tests for services/rateLimit.ts (#343)
 *
 * Covers per-socket rate limiting, total payload size rejection, and
 * per-envelope ciphertext size rejection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkRateLimit,
  checkPayloadSize,
  checkEnvelopeSizes,
  recordViolation,
  clearViolations,
} from '../services/rateLimit.js';

describe('checkRateLimit', () => {
  it('allows all requests when redis is null', async () => {
    const result = await checkRateLimit(null, 'socket-1');
    expect(result.allowed).toBe(true);
  });

  it('allows requests under the per-second limit', async () => {
    const redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    };
    const result = await checkRateLimit(redis as never, 'socket-1');
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it('sets a 1s expiry on the first increment', async () => {
    const redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    };
    await checkRateLimit(redis as never, 'socket-1');
    expect(redis.expire).toHaveBeenCalledWith('rl:socket:socket-1', 1);
  });

  it('does not re-set expiry on subsequent increments', async () => {
    const redis = {
      incr: vi.fn().mockResolvedValue(2),
      expire: vi.fn().mockResolvedValue(1),
    };
    await checkRateLimit(redis as never, 'socket-1');
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('rejects requests once the configured per-second limit is exceeded', async () => {
    vi.stubEnv('SOCKET_RATE_LIMIT_PER_SEC', '5');
    vi.resetModules();
    const { checkRateLimit: checkRateLimitFresh } = await import('../services/rateLimit.js');
    const redis = {
      incr: vi.fn().mockResolvedValue(6),
      expire: vi.fn().mockResolvedValue(1),
    };
    const result = await checkRateLimitFresh(redis as never, 'socket-1');
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(6);
    vi.unstubAllEnvs();
  });

  it('falls back to the default limit of 10 when env var is unset', async () => {
    vi.stubEnv('SOCKET_RATE_LIMIT_PER_SEC', '');
    vi.resetModules();
    const { checkRateLimit: checkRateLimitFresh } = await import('../services/rateLimit.js');
    const redis = {
      incr: vi.fn().mockResolvedValue(10),
      expire: vi.fn().mockResolvedValue(1),
    };
    const result = await checkRateLimitFresh(redis as never, 'socket-1');
    expect(result.allowed).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('checkPayloadSize', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a payload under the default 16384-byte cap', () => {
    const result = checkPayloadSize({ hello: 'world' });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload over the default cap', () => {
    const bigString = 'x'.repeat(20000);
    const result = checkPayloadSize({ data: bigString });
    expect(result.valid).toBe(false);
    expect(result.size).toBeGreaterThan(16384);
  });

  it('respects a configured MAX_PAYLOAD_SIZE override', async () => {
    vi.stubEnv('MAX_PAYLOAD_SIZE', '10');
    vi.resetModules();
    const { checkPayloadSize: checkPayloadSizeFresh } = await import('../services/rateLimit.js');
    const result = checkPayloadSizeFresh({ data: 'this is definitely more than 10 bytes' });
    expect(result.valid).toBe(false);
  });

  it('reports the exact serialized byte size', () => {
    const result = checkPayloadSize('abc');
    expect(result.size).toBe(Buffer.byteLength(JSON.stringify('abc'), 'utf8'));
  });
});

describe('checkEnvelopeSizes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is valid when envelopes is undefined', () => {
    expect(checkEnvelopeSizes(undefined).valid).toBe(true);
  });

  it('is valid when envelopes is empty', () => {
    expect(checkEnvelopeSizes([]).valid).toBe(true);
  });

  it('accepts envelopes whose ciphertext is under the default 4096-byte cap', () => {
    const result = checkEnvelopeSizes([{ recipientDeviceId: 'dev-1', ciphertext: 'short' }]);
    expect(result.valid).toBe(true);
  });

  it('rejects a single envelope whose ciphertext exceeds the cap, even though the aggregate payload looks fine', () => {
    const oversized = 'x'.repeat(5000);
    const result = checkEnvelopeSizes([
      { recipientDeviceId: 'dev-1', ciphertext: 'short' },
      { recipientDeviceId: 'dev-2', ciphertext: oversized },
    ]);
    expect(result.valid).toBe(false);
    expect(result.oversizedDeviceId).toBe('dev-2');
  });

  it('respects a configured MAX_ENVELOPE_SIZE override', async () => {
    vi.stubEnv('MAX_ENVELOPE_SIZE', '5');
    vi.resetModules();
    const { checkEnvelopeSizes: checkEnvelopeSizesFresh } = await import(
      '../services/rateLimit.js'
    );
    const result = checkEnvelopeSizesFresh([
      { recipientDeviceId: 'dev-1', ciphertext: 'this-is-too-long' },
    ]);
    expect(result.valid).toBe(false);
  });

  it('checks every envelope, not just the first', () => {
    const oversized = 'x'.repeat(5000);
    const result = checkEnvelopeSizes([
      { recipientDeviceId: 'dev-1', ciphertext: 'ok' },
      { recipientDeviceId: 'dev-2', ciphertext: 'also ok' },
      { recipientDeviceId: 'dev-3', ciphertext: oversized },
    ]);
    expect(result.valid).toBe(false);
    expect(result.oversizedDeviceId).toBe('dev-3');
  });
});

describe('recordViolation / clearViolations', () => {
  beforeEach(() => {
    clearViolations('socket-v1');
  });

  it('increments violation count per socket', () => {
    expect(recordViolation('socket-v1')).toBe(1);
    expect(recordViolation('socket-v1')).toBe(2);
  });

  it('tracks violations independently per socket', () => {
    clearViolations('socket-v2');
    expect(recordViolation('socket-v1')).toBe(1);
    expect(recordViolation('socket-v2')).toBe(1);
  });

  it('resets the count after clearViolations', () => {
    recordViolation('socket-v1');
    recordViolation('socket-v1');
    clearViolations('socket-v1');
    expect(recordViolation('socket-v1')).toBe(1);
  });
});
