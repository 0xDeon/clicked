import { createHash, randomUUID } from 'node:crypto';

const PRESIGNED_TTL_SECONDS = 900; // 15 minutes

// In production this would call S3/GCS SDK to generate a real presigned URL.
// The indirection keeps the route logic testable without cloud credentials.
export async function generatePresignedPut(storageKey: string, _mimeType: string): Promise<string> {
  const base = process.env['STORAGE_ENDPOINT'] ?? 'https://storage.example.com';
  const expires = Math.floor(Date.now() / 1000) + PRESIGNED_TTL_SECONDS;
  return `${base}/${storageKey}?X-Expires=${expires}`;
}

export function generateStorageKey(conversationId: string, sha256: string): string {
  // Deterministic per (conversation, content) so duplicate uploads share a key.
  const hash = createHash('sha256')
    .update(`${conversationId}:${sha256}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 16);
  return `uploads/${conversationId}/${hash}`;
}
