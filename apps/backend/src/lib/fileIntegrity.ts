/**
 * File integrity verification using SHA-256.
 *
 * Verifies uploaded file content matches the claimed hash before marking as ready.
 * Works with local filesystem storage, S3, and MinIO.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { getObjectStore } from './objectStore.js';

export interface IntegrityCheckResult {
  valid: boolean;
  computedHash?: string;
  expectedHash?: string;
  error?: string;
}

/**
 * Compute SHA-256 hash of a stream (streaming hashing for large files).
 *
 * @param stream - Readable stream of file content
 * @returns Hex-encoded SHA-256 hash
 */
export async function computeSha256FromStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Compute SHA-256 hash of a buffer (for in-memory content).
 *
 * @param buffer - File content buffer
 * @returns Hex-encoded SHA-256 hash
 */
export function computeSha256FromBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify the integrity of an uploaded file against its claimed SHA-256 hash.
 *
 * Retrieves the object from storage, computes its SHA-256, and compares.
 * Uses streaming hashing to avoid loading large files into memory.
 *
 * @param storageKey - The storage key/path of the uploaded object
 * @param expectedSha256 - The hex-encoded SHA-256 hash claimed by the client
 * @returns Integrity check result with validation status
 */
export async function verifyFileIntegrity(
  storageKey: string,
  expectedSha256: string,
): Promise<IntegrityCheckResult> {
  try {
    const store = getObjectStore();

    // Fetch the object from storage
    const response = await store.getObject(storageKey);

    if (!response.Body) {
      return {
        valid: false,
        error: 'Object not found or empty',
        expectedHash: expectedSha256,
      };
    }

    // Convert Body to Readable stream for streaming hash computation
    const stream = response.Body as Readable;
    const computedHash = await computeSha256FromStream(stream);

    // Compare hashes (case-insensitive)
    const valid = computedHash.toLowerCase() === expectedSha256.toLowerCase();

    return {
      valid,
      computedHash,
      expectedHash: expectedSha256,
      ...(valid ? {} : { error: 'Hash mismatch' }),
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error during integrity check',
      expectedHash: expectedSha256,
    };
  }
}

/**
 * Verify file size matches the expected size.
 *
 * @param storageKey - The storage key/path of the uploaded object
 * @param expectedSize - The size in bytes claimed by the client
 * @returns True if size matches, false otherwise
 */
export async function verifyFileSize(storageKey: string, expectedSize: number): Promise<boolean> {
  try {
    const store = getObjectStore();
    const response = await store.getObject(storageKey);

    if (!response.Body) {
      return false;
    }

    // Get content length from response
    const actualSize = response.ContentLength;

    if (actualSize === undefined) {
      return false;
    }

    return actualSize === expectedSize;
  } catch {
    return false;
  }
}
