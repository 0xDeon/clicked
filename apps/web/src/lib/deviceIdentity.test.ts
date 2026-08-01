import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { getOrCreateDeviceIdentity, getStoredDeviceId } from './deviceIdentity';

function makeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

beforeEach(() => {
  const localStorage = makeLocalStorage();
  vi.stubGlobal(
    'crypto',
    {
      subtle: webcrypto.subtle,
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: () => 'device-uuid-fixed',
    },
  );
  vi.stubGlobal('window', {
    localStorage,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
  });
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
});

describe('device identity bootstrap', () => {
  it('creates and reuses the same device identity locally', async () => {
    const first = await getOrCreateDeviceIdentity();
    const second = await getOrCreateDeviceIdentity();

    expect(first).toEqual(second);
    expect(first.deviceId).toBe('device-uuid-fixed');
    expect(first.deviceName).toBe('MacIntel browser');
    expect(first.platform).toBe('web');
    expect(Buffer.from(first.identityPublicKey, 'base64').length).toBeGreaterThan(0);
    expect(getStoredDeviceId()).toBe('device-uuid-fixed');
  });
});
