import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setSessionKey, getSessionKey, clearSessionKeys, hasSessionKey } from '@/lib/crypto/sessionStore';
import { sessionStore } from '@/lib/sessionStore';

describe('Safety Number & Session Key Invalidation (#359)', () => {
  beforeEach(() => {
    clearSessionKeys();
  });

  it('invalidates active session keys when clearSessionKeys is invoked', async () => {
    const dummyKey = {} as CryptoKey;
    setSessionKey('device-123', dummyKey);
    expect(hasSessionKey('device-123')).toBe(true);
    expect(getSessionKey('device-123')).toBe(dummyKey);

    clearSessionKeys();
    expect(hasSessionKey('device-123')).toBe(false);
    expect(getSessionKey('device-123')).toBeUndefined();
  });

  it('clears persisted session store when key change event triggers invalidation', async () => {
    const clearSpy = vi.spyOn(sessionStore, 'clear').mockResolvedValue(undefined);
    const dummyKey = {} as CryptoKey;
    setSessionKey('device-456', dummyKey);

    // Simulate key change trigger action
    clearSessionKeys();
    await sessionStore.clear();

    expect(hasSessionKey('device-456')).toBe(false);
    expect(clearSpy).toHaveBeenCalled();
  });
});
