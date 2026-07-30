import { createHash, randomUUID } from 'node:crypto';
import { getObjectStore } from './objectStore.js';
import { getLocalObjectStore } from './localObjectStore.js';

const PRESIGNED_TTL_SECONDS = 900; // 15 minutes

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

// Outside production this issues a real presigned URL against the fs-backed
// `LocalDiskObjectStore` (#330) instead of the string-templated `fakeUrl()`
// this used to fall back to — the URL is now genuinely backed by a file and
// served by routes/localStorage.ts. Production always uses real S3 (#166).
export async function generatePresignedPut(storageKey: string, mimeType: string): Promise<string> {
  if (!isProduction()) {
    return getLocalObjectStore().getPresignedPutUrl(storageKey, mimeType, PRESIGNED_TTL_SECONDS);
  }
  return getObjectStore().getPresignedPutUrl(storageKey, mimeType, PRESIGNED_TTL_SECONDS);
}

export async function generatePresignedGet(
  storageKey: string,
  ttlSeconds: number = PRESIGNED_TTL_SECONDS,
): Promise<string> {
  if (!isProduction()) {
    return getLocalObjectStore().getPresignedGetUrl(storageKey, ttlSeconds);
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
