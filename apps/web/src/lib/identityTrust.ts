/**
 * identityTrust.ts — peer identity-key pinning and session reset.
 *
 * The server enforces prekey/signature invariants (apps/backend/src/lib/keys.ts)
 * but has no notion of "is this still the identity key I trust" — that's a
 * client-side, trust-on-first-use (TOFU) decision, same as Signal.
 *
 * The first time we ever encrypt to a peer we pin their current device set
 * (device id + identityPublicKey per device, matching GET
 * /conversations/:id/devices). Every subsequent send re-checks the live set
 * against the pin:
 *
 *   - unchanged             -> proceed
 *   - never pinned before   -> trust-on-first-use: pin it, proceed
 *   - changed (add/remove/  -> STOP. A revoke+relink and a rogue device
 *     swap any device)         inserted server-side look identical from the
 *                               wire, so the only safe default is to refuse
 *                               to encrypt until the user re-verifies (the
 *                               safety-number UI) — this is why Signal shows
 *                               a "safety number changed" warning even for
 *                               mundane reinstalls.
 *
 * This module is the single source of truth for that pin: both the
 * encryption pipeline (crypto.ts, signalClient.ts — via
 * `assertDevicesTrusted`) and the safety-number UI
 * (app/app/conversations/[id]/page.tsx) read and write the same record, so
 * "sends are blocked" and "the user is warned" can never desync.
 */

export interface TrustedDevice {
  id: string;
  identityPublicKey: string;
}

export interface TrustedSnapshot {
  devices: TrustedDevice[];
  trustedAt: string;
}

export class IdentityKeyChangedError extends Error {
  readonly userId: string;
  readonly changedDeviceIds: string[];

  constructor(userId: string, changedDeviceIds: string[]) {
    super(
      `Identity key changed for user ${userId} — refusing to encrypt until the new safety number is verified`,
    );
    this.name = 'IdentityKeyChangedError';
    this.userId = userId;
    this.changedDeviceIds = changedDeviceIds;
  }
}

function storageKey(userId: string): string {
  return `clicked.identityTrust.${userId}`;
}

// Falls back to an in-memory map when `window.localStorage` isn't available
// (SSR, a Node test environment, or a webview that disables storage) so the
// trust check always has *something* to compare against within a process's
// lifetime rather than silently disabling the invariant by always reporting
// "first contact".
const memoryFallback = new Map<string, string>();

function readRaw(key: string): string | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem(key);
  }
  return memoryFallback.get(key) ?? null;
}

function writeRaw(key: string, value: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, value);
    return;
  }
  memoryFallback.set(key, value);
}

function removeRaw(key: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(key);
    return;
  }
  memoryFallback.delete(key);
}

function sortDevices(devices: TrustedDevice[]): TrustedDevice[] {
  return [...devices].sort((a, b) => a.id.localeCompare(b.id));
}

function fingerprintOf(devices: TrustedDevice[]): string {
  return sortDevices(devices)
    .map((d) => `${d.id}:${d.identityPublicKey}`)
    .join('|');
}

export function getTrustedSnapshot(userId: string): TrustedSnapshot | null {
  try {
    const raw = readRaw(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TrustedSnapshot>;
    if (!Array.isArray(parsed.devices) || typeof parsed.trustedAt !== 'string') return null;
    return { devices: parsed.devices, trustedAt: parsed.trustedAt };
  } catch {
    return null;
  }
}

function saveSnapshot(userId: string, devices: TrustedDevice[]): TrustedSnapshot {
  const snapshot: TrustedSnapshot = {
    devices: sortDevices(devices),
    trustedAt: new Date().toISOString(),
  };
  writeRaw(storageKey(userId), JSON.stringify(snapshot));
  return snapshot;
}

/**
 * Explicitly (re-)pins `devices` as trusted for `userId`. Called on first
 * contact (automatically) and after the user re-verifies a changed safety
 * number (conversation page "Mark verified" action) — the latter is the
 * re-handshake trigger: once trust is re-established, the next send derives
 * a fresh session under the new key instead of refusing to proceed.
 */
export function trustDevices(userId: string, devices: TrustedDevice[]): TrustedSnapshot {
  return saveSnapshot(userId, devices);
}

export function clearTrustedSnapshot(userId: string): void {
  removeRaw(storageKey(userId));
}

/**
 * Session-store modules (e.g. signalClient.ts's Phase-2 ratchet store)
 * register a reset callback here so a detected identity-key change tears
 * down their cached session state too, without this module needing to
 * import them directly (avoids signalClient -> crypto -> identityTrust ->
 * signalClient cycles).
 */
const sessionResetHandlers = new Set<(deviceIds: string[]) => void>();

export function onSessionReset(handler: (deviceIds: string[]) => void): () => void {
  sessionResetHandlers.add(handler);
  return () => sessionResetHandlers.delete(handler);
}

function resetSessions(deviceIds: string[]): void {
  for (const handler of sessionResetHandlers) handler(deviceIds);
}

export interface IdentityCheckResult {
  status: 'trusted' | 'first-contact' | 'changed';
  changedDeviceIds: string[];
}

/**
 * Compares `devices` (the live, server-reported device set for one peer)
 * against the pinned snapshot for `userId`, tearing down session state and
 * refusing trust on a mismatch. Pure and synchronous — safe to call on
 * every send without extra network round-trips (callers already fetched the
 * live device set for envelope-building).
 */
export function checkIdentityChange(
  userId: string,
  devices: TrustedDevice[],
): IdentityCheckResult {
  const snapshot = getTrustedSnapshot(userId);

  if (!snapshot) {
    trustDevices(userId, devices);
    return { status: 'first-contact', changedDeviceIds: [] };
  }

  if (fingerprintOf(snapshot.devices) === fingerprintOf(devices)) {
    return { status: 'trusted', changedDeviceIds: [] };
  }

  const changedDeviceIds = new Set<string>();
  for (const device of devices) {
    const trusted = snapshot.devices.find((d) => d.id === device.id);
    if (!trusted || trusted.identityPublicKey !== device.identityPublicKey) {
      changedDeviceIds.add(device.id);
    }
  }
  for (const trusted of snapshot.devices) {
    if (!devices.some((d) => d.id === trusted.id)) changedDeviceIds.add(trusted.id);
  }

  // Tear down any cached session state for the affected devices — do NOT
  // update the pin. The pin only moves forward via an explicit
  // `trustDevices` call (i.e. the user re-verifying), so every send keeps
  // failing closed until that happens.
  resetSessions([...changedDeviceIds]);

  return { status: 'changed', changedDeviceIds: [...changedDeviceIds] };
}
