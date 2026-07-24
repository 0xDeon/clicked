import { createHash, randomUUID } from 'node:crypto';
import { getObjectStore } from './objectStore.js';

const PRESIGNED_TTL_SECONDS = 900; // 15 minutes

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

// Development/test fallback: a structurally-plausible but fake URL, never
// backed by a network call. Keeps local dev and CI from needing a reachable
// S3/MinIO endpoint just to exercise the upload/download routes (same "no
// external services in tests" rule this project applies to Redis/Postgres).
// Production always returns a real, cryptographically-signed URL (#166).
function fakeUrl(storageKey: string, ttlSeconds: number): string {
  const base = process.env['STORAGE_ENDPOINT'] ?? 'https://storage.example.com';
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${base}/${storageKey}?X-Expires=${expires}`;
}

export async function generatePresignedPut(storageKey: string, mimeType: string): Promise<string> {
  if (!isProduction()) {
    return fakeUrl(storageKey, PRESIGNED_TTL_SECONDS);
  }
  return getObjectStore().getPresignedPutUrl(storageKey, mimeType, PRESIGNED_TTL_SECONDS);
}

export async function generatePresignedGet(
  storageKey: string,
  ttlSeconds: number = PRESIGNED_TTL_SECONDS,
): Promise<string> {
  if (!isProduction()) {
    return fakeUrl(storageKey, ttlSeconds);
  }
  return getObjectStore().getPresignedGetUrl(storageKey, ttlSeconds);
}

export function generateStorageKey(conversationId: string, sha256: string): string {
  // Deterministic per (conversation, content) so duplicate uploads share a key.
  const hash = createHash('sha256')
    .update(`${conversationId}:${sha256}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 16);
  return `uploads/${conversationId}/${hash}`;
}
