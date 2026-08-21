/**
 * Tests for services/rateLimit.ts (#343)
 *
 * Covers per-socket rate limiting, total payload size rejection, and
 * per-envelope ciphertext size rejection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkSocketEventRateLimit,
  checkPayloadSize,
  checkEnvelopeSizes,
  recordViolation,
  clearViolations,
} from '../services/rateLimit.js';
import { clearLocalRateLimitCounters } from '../services/rateLimiter.js';
import { RATE_LIMIT_DEFAULTS } from '../config/rateLimits.js';

// Budgets live in config/rateLimits.ts (#375); this module only decides which
// bucket an event is charged to. With no Redis configured, consumeRateLimit
// falls back to in-process counters, so these run without a server.
describe('checkSocketEventRateLimit', () => {
  beforeEach(() => {
    clearLocalRateLimitCounters();
  });

  it('charges the device, not the socket, so reconnecting cannot reset the budget', async () => {
    const first = await checkSocketEventRateLimit('send_message', 'device-1');
    const second = await checkSocketEventRateLimit('send_message', 'device-1');

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBeLessThan(first.remaining);
  });

  it('tracks each device independently', async () => {
    await checkSocketEventRateLimit('send_message', 'device-1');
    const other = await checkSocketEventRateLimit('send_message', 'device-2');

    expect(other.remaining).toBe(RATE_LIMIT_DEFAULTS.socket_send_message.limit - 1);
  });

  it('routes an event with no dedicated bucket to socket_default', async () => {
    const result = await checkSocketEventRateLimit('some_unmapped_event', 'device-1');
    expect(result.limit).toBe(RATE_LIMIT_DEFAULTS.socket_default.limit);
  });

  it('routes send_file_message to the same bucket as send_message', async () => {
    const result = await checkSocketEventRateLimit('send_file_message', 'device-1');
    expect(result.limit).toBe(RATE_LIMIT_DEFAULTS.socket_send_message.limit);
  });

  it('rejects once the bucket limit is exhausted', async () => {
    const limit = RATE_LIMIT_DEFAULTS.socket_ask_assistant.limit;
    let last = await checkSocketEventRateLimit('ask_assistant', 'device-1');
    for (let i = 1; i < limit; i += 1) {
      last = await checkSocketEventRateLimit('ask_assistant', 'device-1');
    }
    expect(last.allowed).toBe(true);

    const overflow = await checkSocketEventRateLimit('ask_assistant', 'device-1');
    expect(overflow.allowed).toBe(false);
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
    const { checkEnvelopeSizes: checkEnvelopeSizesFresh } =
      await import('../services/rateLimit.js');
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
