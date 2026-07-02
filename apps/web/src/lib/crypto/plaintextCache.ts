/**
 * In-memory cache of decrypted plaintext keyed by messageId.
 * Cleared on page unload — no persistence (#185 deferred).
 */

const cache = new Map<string, string>();

export function getCachedPlaintext(messageId: string): string | undefined {
  return cache.get(messageId);
}

export function setCachedPlaintext(messageId: string, plaintext: string): void {
  cache.set(messageId, plaintext);
}

export function hasCachedPlaintext(messageId: string): boolean {
  return cache.has(messageId);
}

export function clearPlaintextCache(): void {
  cache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', clearPlaintextCache);
}
