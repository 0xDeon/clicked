import { randomBytes } from 'crypto';

const TTL_MS = 5 * 60 * 1000;

/**
 * Device-link challenges are a re-authentication step for an already
 * signed-in session, so they get a tighter window than a login challenge.
 */
const DEVICE_LINK_TTL_MS = 2 * 60 * 1000;

const store = new Map<string, { nonce: string; expiresAt: number }>();

/**
 * Device-link nonces live in their own map, keyed by userId rather than
 * wallet address. Sharing the login store would let a device-link challenge
 * and a login challenge for the same wallet silently overwrite each other.
 */
const deviceLinkStore = new Map<string, { nonce: string; expiresAt: number }>();

function issue(
  target: Map<string, { nonce: string; expiresAt: number }>,
  key: string,
  ttlMs: number,
): string {
  const nonce = randomBytes(16).toString('hex');
  target.set(key, { nonce, expiresAt: Date.now() + ttlMs });
  return nonce;
}

/** Single-use: the entry is removed on read whether or not it turns out valid. */
function consume(
  target: Map<string, { nonce: string; expiresAt: number }>,
  key: string,
  nonce: string,
): boolean {
  const entry = target.get(key);
  if (!entry) return false;
  target.delete(key);
  if (Date.now() > entry.expiresAt) return false;
  return entry.nonce === nonce;
}

export function createNonce(walletAddress: string): string {
  return issue(store, walletAddress, TTL_MS);
}

export function consumeNonce(walletAddress: string, nonce: string): boolean {
  return consume(store, walletAddress, nonce);
}

/** Issue a device-linking / re-authentication challenge nonce for a user (#333). */
export function createDeviceLinkNonce(userId: string): string {
  return issue(deviceLinkStore, userId, DEVICE_LINK_TTL_MS);
}

/** Validate and burn a device-linking nonce. Single-use and short-lived. */
export function consumeDeviceLinkNonce(userId: string, nonce: string): boolean {
  return consume(deviceLinkStore, userId, nonce);
}
