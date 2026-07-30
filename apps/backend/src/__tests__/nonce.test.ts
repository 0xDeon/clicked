import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createNonce,
  consumeNonce,
  createDeviceLinkNonce,
  consumeDeviceLinkNonce,
} from '../lib/nonce.js';

describe('Nonce store', () => {
  const wallet = 'GABCDEFGHIJKLMNOP';

  it('creates a 32-char hex nonce', () => {
    const nonce = createNonce(wallet);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('consuming a valid nonce returns true', () => {
    const nonce = createNonce(wallet);
    expect(consumeNonce(wallet, nonce)).toBe(true);
  });

  it('consuming the same nonce twice returns false (single-use)', () => {
    const nonce = createNonce(wallet);
    consumeNonce(wallet, nonce);
    expect(consumeNonce(wallet, nonce)).toBe(false);
  });

  it('consuming a wrong nonce returns false', () => {
    createNonce(wallet);
    expect(consumeNonce(wallet, 'wrong-nonce')).toBe(false);
  });

  it('consuming a nonce for an unknown wallet returns false', () => {
    expect(consumeNonce('UNKNOWN_WALLET', 'any-nonce')).toBe(false);
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects a nonce after 5 minutes have passed', () => {
      const nonce = createNonce(wallet);
      // Advance time past the 5-minute TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(consumeNonce(wallet, nonce)).toBe(false);
    });

    it('accepts a nonce just before expiry', () => {
      const nonce = createNonce(wallet);
      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(consumeNonce(wallet, nonce)).toBe(true);
    });
  });
});

describe('Device-link nonce store (#333)', () => {
  const userId = 'user-1';

  it('creates a 32-char hex nonce', () => {
    expect(createDeviceLinkNonce(userId)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('consuming a valid nonce returns true', () => {
    const nonce = createDeviceLinkNonce(userId);
    expect(consumeDeviceLinkNonce(userId, nonce)).toBe(true);
  });

  it('is single-use', () => {
    const nonce = createDeviceLinkNonce(userId);
    consumeDeviceLinkNonce(userId, nonce);
    expect(consumeDeviceLinkNonce(userId, nonce)).toBe(false);
  });

  it('rejects a nonce for a user that never requested a challenge', () => {
    expect(consumeDeviceLinkNonce('unknown-user', 'any-nonce')).toBe(false);
  });

  it('rejects a nonce issued for a different user', () => {
    const nonce = createDeviceLinkNonce(userId);
    expect(consumeDeviceLinkNonce('user-2', nonce)).toBe(false);
  });

  it('does not share a keyspace with the login nonce store', () => {
    // Same string used as both a wallet address and a userId: issuing one
    // challenge must not invalidate or satisfy the other.
    const key = 'SHARED_KEY';
    const loginNonce = createNonce(key);
    const linkNonce = createDeviceLinkNonce(key);

    expect(consumeDeviceLinkNonce(key, loginNonce)).toBe(false);
    expect(consumeNonce(key, loginNonce)).toBe(true);

    const loginNonce2 = createNonce(key);
    const linkNonce2 = createDeviceLinkNonce(key);
    expect(consumeNonce(key, linkNonce2)).toBe(false);
    expect(consumeDeviceLinkNonce(key, linkNonce2)).toBe(true);
    expect(linkNonce).not.toBe(loginNonce2);
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects a device-link nonce after its 2-minute TTL', () => {
      const nonce = createDeviceLinkNonce(userId);
      vi.advanceTimersByTime(2 * 60 * 1000 + 1);
      expect(consumeDeviceLinkNonce(userId, nonce)).toBe(false);
    });

    it('accepts a device-link nonce just before expiry', () => {
      const nonce = createDeviceLinkNonce(userId);
      vi.advanceTimersByTime(2 * 60 * 1000 - 1);
      expect(consumeDeviceLinkNonce(userId, nonce)).toBe(true);
    });
  });
});
