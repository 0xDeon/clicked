export interface JwtPayload {
  userId: string;
  walletAddress: string;
  deviceId: string;
}

export function parseJwtPayload(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(normalized)) as Partial<JwtPayload>;
    if (!decoded.userId || !decoded.deviceId) return null;
    return decoded as JwtPayload;
  } catch {
    return null;
  }
}

const E2E_DEVICE_STORAGE_KEY = 'clicked.e2eDeviceId';

/** userDevices.id used for envelope sync — may differ from JWT devices.id. */
export function getE2EDeviceId(token: string): string | null {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(E2E_DEVICE_STORAGE_KEY);
    if (stored) return stored;
  }
  return parseJwtPayload(token)?.deviceId ?? null;
}

export function setE2EDeviceId(deviceId: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(E2E_DEVICE_STORAGE_KEY, deviceId);
  }
}
