import { API_BASE_URL } from '@/lib/api';
import type { DevicePublicKey } from './types';

const keyCache = new Map<string, DevicePublicKey>();

/**
 * Fetch the sender device's identity public key by senderDeviceId (#122).
 * Results are cached in memory for the lifetime of the page.
 */
export async function fetchSenderDevicePublicKey(
  senderDeviceId: string,
  token: string,
): Promise<DevicePublicKey> {
  const cached = keyCache.get(senderDeviceId);
  if (cached) return cached;

  const res = await fetch(`${API_BASE_URL}/user-devices/${senderDeviceId}/public-key`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch public key for device ${senderDeviceId}`);
  }

  const data = (await res.json()) as DevicePublicKey;
  keyCache.set(senderDeviceId, data);
  return data;
}

export function getCachedDevicePublicKey(senderDeviceId: string): DevicePublicKey | undefined {
  return keyCache.get(senderDeviceId);
}

export function clearDeviceKeyCache(): void {
  keyCache.clear();
}
