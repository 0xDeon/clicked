'use client';

const DEVICE_ID_KEY = 'clicked.e2eeDeviceId';
const DEVICE_IDENTITY_KEY = 'clicked.deviceIdentityPublicKey';

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey('spki', key);
  let binary = '';
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function randomDeviceName(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return `${nav?.platform || 'Web'} browser`;
}

export function getStoredDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DEVICE_ID_KEY);
}

export async function getOrCreateDeviceIdentity(): Promise<{
  deviceId: string;
  deviceName: string;
  platform: 'web';
  identityPublicKey: string;
}> {
  const existingDeviceId = window.localStorage.getItem(DEVICE_ID_KEY);
  const existingIdentity = window.localStorage.getItem(DEVICE_IDENTITY_KEY);
  if (existingDeviceId && existingIdentity) {
    return {
      deviceId: existingDeviceId,
      deviceName: randomDeviceName(),
      platform: 'web',
      identityPublicKey: existingIdentity,
    };
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const identityPublicKey = await exportPublicKey(keyPair.publicKey);
  const deviceId = existingDeviceId ?? crypto.randomUUID();

  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
  window.localStorage.setItem(DEVICE_IDENTITY_KEY, identityPublicKey);

  return {
    deviceId,
    deviceName: randomDeviceName(),
    platform: 'web',
    identityPublicKey,
  };
}
