/**
 * Tests for fetchVapidPublicKey (#349).
 *
 * The frontend must fetch the VAPID public key from the backend instead of
 * a build-time env var, and gracefully return null (skip push registration)
 * whenever the backend has no key configured, the request fails, or the
 * response can't be parsed — it must never throw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchVapidPublicKey } from './usePushSubscription';

function mockFetchOnce(response: { ok: boolean; json: () => Promise<unknown> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(response as unknown as Response),
  );
}

describe('fetchVapidPublicKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the key when the backend reports it is configured', async () => {
    mockFetchOnce({
      ok: true,
      json: () => Promise.resolve({ configured: true, vapidPublicKey: 'abc123' }),
    });

    const key = await fetchVapidPublicKey('token-1');

    expect(key).toBe('abc123');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/push/vapid-public-key'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token-1' } }),
    );
  });

  it('returns null when the backend reports VAPID is not configured', async () => {
    mockFetchOnce({
      ok: true,
      json: () => Promise.resolve({ configured: false, vapidPublicKey: null }),
    });

    expect(await fetchVapidPublicKey('token-1')).toBeNull();
  });

  it('returns null when configured is true but the key is missing (defensive)', async () => {
    mockFetchOnce({
      ok: true,
      json: () => Promise.resolve({ configured: true, vapidPublicKey: null }),
    });

    expect(await fetchVapidPublicKey('token-1')).toBeNull();
  });

  it('returns null on a non-2xx response instead of throwing', async () => {
    mockFetchOnce({ ok: false, json: () => Promise.resolve({}) });

    expect(await fetchVapidPublicKey('token-1')).toBeNull();
  });

  it('returns null when fetch itself rejects (network failure) instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchVapidPublicKey('token-1')).resolves.toBeNull();
  });

  it('returns null when the response body is not valid JSON', async () => {
    mockFetchOnce({
      ok: true,
      json: () => Promise.reject(new Error('invalid JSON')),
    });

    await expect(fetchVapidPublicKey('token-1')).resolves.toBeNull();
  });
});
