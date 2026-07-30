/**
 * In-memory AES session keys keyed by senderDeviceId.
 * Populated when a device link / X3DH session is established (outbound path).
 */

const sessionKeys = new Map<string, CryptoKey>();

export function getSessionKey(senderDeviceId: string): CryptoKey | undefined {
  return sessionKeys.get(senderDeviceId);
}

export function setSessionKey(senderDeviceId: string, key: CryptoKey): void {
  sessionKeys.set(senderDeviceId, key);
}

export function hasSessionKey(senderDeviceId: string): boolean {
  return sessionKeys.has(senderDeviceId);
}

export function removeSessionKey(senderDeviceId: string): void {
  sessionKeys.delete(senderDeviceId);
}

export function clearSessionKeys(): void {
  sessionKeys.clear();
}

/** Import a raw 256-bit AES key for a linked sender device. */
export async function importSessionKey(
  senderDeviceId: string,
  rawKeyBytes: ArrayBuffer,
): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  sessionKeys.set(senderDeviceId, key);
  return key;
}

