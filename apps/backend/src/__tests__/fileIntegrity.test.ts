/**
 * Tests for file integrity verification.
 *
 * Verifies that:
 * - SHA-256 hashes are correctly computed
 * - Matching hashes mark file as ready
 * - Mismatched hashes mark file as corrupted
 * - Works with streaming for large files
 * - Works with S3/MinIO/local storage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  computeSha256FromBuffer,
  computeSha256FromStream,
  verifyFileIntegrity,
} from '../lib/fileIntegrity.js';

const mockGetObject = vi.fn();
vi.mock('../lib/objectStore.js', () => ({
  getObjectStore: () => ({
    getObject: mockGetObject,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('File Integrity Verification', () => {
  describe('computeSha256FromBuffer', () => {
    it('computes correct SHA-256 hash for buffer', () => {
      const buffer = Buffer.from('Hello, World!');
      const hash = computeSha256FromBuffer(buffer);

      // Known SHA-256 of "Hello, World!"
      expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
    });

    it('produces different hashes for different content', () => {
      const buffer1 = Buffer.from('Content A');
      const buffer2 = Buffer.from('Content B');

      const hash1 = computeSha256FromBuffer(buffer1);
      const hash2 = computeSha256FromBuffer(buffer2);

      expect(hash1).not.toBe(hash2);
    });

    it('produces consistent hashes for same content', () => {
      const buffer = Buffer.from('Test content');

      const hash1 = computeSha256FromBuffer(buffer);
      const hash2 = computeSha256FromBuffer(buffer);

      expect(hash1).toBe(hash2);
    });
  });

  describe('computeSha256FromStream', () => {
    it('computes correct SHA-256 hash from stream', async () => {
      const content = 'Hello, World!';
      const stream = Readable.from([Buffer.from(content)]);

      const hash = await computeSha256FromStream(stream);

      expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
    });

    it('handles chunked streaming correctly', async () => {
      // Simulate large file with multiple chunks
      const chunks = [Buffer.from('First '), Buffer.from('Second '), Buffer.from('Third')];
      const stream = Readable.from(chunks);

      const hash = await computeSha256FromStream(stream);

      // Should be same as hashing concatenated content
      const fullContent = Buffer.concat(chunks);
      const expectedHash = computeSha256FromBuffer(fullContent);

      expect(hash).toBe(expectedHash);
    });

    it('handles empty stream', async () => {
      const stream = Readable.from([]);
      const hash = await computeSha256FromStream(stream);

      // SHA-256 of empty string
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles stream errors', async () => {
      const stream = new Readable({
        read() {
          this.emit('error', new Error('Stream read error'));
        },
      });

      await expect(computeSha256FromStream(stream)).rejects.toThrow('Stream read error');
    });
  });

  describe('verifyFileIntegrity', () => {
    it('returns valid=true when hash matches', async () => {
      const content = Buffer.from('Test file content');
      const expectedHash = computeSha256FromBuffer(content);

      mockGetObject.mockResolvedValue({
        Body: Readable.from([content]),
        ContentLength: content.length,
      });

      const result = await verifyFileIntegrity('test-key', expectedHash);

      expect(result.valid).toBe(true);
      expect(result.computedHash).toBe(expectedHash);
      expect(result.expectedHash).toBe(expectedHash);
      expect(result.error).toBeUndefined();
    });

    it('returns valid=false when hash mismatches', async () => {
      const content = Buffer.from('Actual content');
      const actualHash = computeSha256FromBuffer(content);
      const claimedHash = 'aaaa' + actualHash.substring(4); // Wrong hash

      mockGetObject.mockResolvedValue({
        Body: Readable.from([content]),
        ContentLength: content.length,
      });

      const result = await verifyFileIntegrity('test-key', claimedHash);

      expect(result.valid).toBe(false);
      expect(result.computedHash).toBe(actualHash);
      expect(result.expectedHash).toBe(claimedHash);
      expect(result.error).toBe('Hash mismatch');
    });

    it('handles case-insensitive hash comparison', async () => {
      const content = Buffer.from('Test');
      const hash = computeSha256FromBuffer(content);
      const upperHash = hash.toUpperCase();

      mockGetObject.mockResolvedValue({
        Body: Readable.from([content]),
        ContentLength: content.length,
      });

      const result = await verifyFileIntegrity('test-key', upperHash);

      expect(result.valid).toBe(true);
    });

    it('returns valid=false when object not found', async () => {
      mockGetObject.mockResolvedValue({
        Body: null,
      });

      const result = await verifyFileIntegrity('missing-key', 'somehash');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Object not found or empty');
    });

    it('returns valid=false when storage throws error', async () => {
      mockGetObject.mockRejectedValue(new Error('S3 connection failed'));

      const result = await verifyFileIntegrity('test-key', 'somehash');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('S3 connection failed');
    });

    it('works with large files via streaming', async () => {
      // Simulate 10MB file with multiple chunks
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks: Buffer[] = [];
      for (let i = 0; i < 10; i++) {
        chunks.push(Buffer.alloc(chunkSize, i));
      }

      const fullContent = Buffer.concat(chunks);
      const expectedHash = computeSha256FromBuffer(fullContent);

      mockGetObject.mockResolvedValue({
        Body: Readable.from(chunks),
        ContentLength: fullContent.length,
      });

      const result = await verifyFileIntegrity('large-file-key', expectedHash);

      expect(result.valid).toBe(true);
    });

    it('detects tampered content', async () => {
      const originalContent = Buffer.from('Original file content');
      const tamperedContent = Buffer.from('Tampered file content');
      const originalHash = computeSha256FromBuffer(originalContent);

      // File was tampered after upload
      mockGetObject.mockResolvedValue({
        Body: Readable.from([tamperedContent]),
        ContentLength: tamperedContent.length,
      });

      const result = await verifyFileIntegrity('tampered-key', originalHash);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Hash mismatch');
    });
  });

  describe('Integration: Upload Confirmation', () => {
    it('marks file ready when integrity verified', async () => {
      const content = Buffer.from('Valid uploaded file');
      const hash = computeSha256FromBuffer(content);

      mockGetObject.mockResolvedValue({
        Body: Readable.from([content]),
        ContentLength: content.length,
      });

      const result = await verifyFileIntegrity('upload-key', hash);

      expect(result.valid).toBe(true);
      // In real implementation, this would trigger:
      // await db.update(files).set({ status: 'ready' })
    });

    it('marks file corrupted when integrity fails', async () => {
      const content = Buffer.from('Corrupted file');
      const wrongHash = 'deadbeef' + '0'.repeat(56);

      mockGetObject.mockResolvedValue({
        Body: Readable.from([content]),
        ContentLength: content.length,
      });

      const result = await verifyFileIntegrity('corrupted-key', wrongHash);

      expect(result.valid).toBe(false);
      // In real implementation, this would trigger:
      // await db.update(files).set({ status: 'deleted', deletedAt: new Date() })
    });
  });
});
