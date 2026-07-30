/**
 * Tests for the fs-backed local object store (#330) — the dev/test
 * replacement for `fakeUrl()` that backs presigned URLs with real files
 * under a gitignored directory instead of a never-dereferenced string.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalDiskObjectStore,
  getLocalObjectStore,
  verifySignedRequest,
} from '../lib/localObjectStore.js';

let dir: string;
let originalDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-object-store-'));
  originalDir = process.env['LOCAL_STORAGE_DIR'];
  process.env['LOCAL_STORAGE_DIR'] = dir;
});

afterEach(() => {
  if (originalDir === undefined) delete process.env['LOCAL_STORAGE_DIR'];
  else process.env['LOCAL_STORAGE_DIR'] = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalDiskObjectStore', () => {
  it('round-trips bytes through put/get', async () => {
    const store = new LocalDiskObjectStore();
    await store.putObject('uploads/conv-1/file-a', Buffer.from('hello world'), 'text/plain');

    const { Body, ContentType } = await store.getObject('uploads/conv-1/file-a');
    expect(Body.toString()).toBe('hello world');
    expect(ContentType).toBe('text/plain');
  });

  it('deleteObject removes the file so a subsequent getObject rejects', async () => {
    const store = new LocalDiskObjectStore();
    await store.putObject('uploads/conv-1/file-b', Buffer.from('bye'));
    await store.deleteObject('uploads/conv-1/file-b');

    expect(await store.exists('uploads/conv-1/file-b')).toBe(false);
    await expect(store.getObject('uploads/conv-1/file-b')).rejects.toThrow();
  });

  it('rejects storage keys that attempt path traversal', async () => {
    const store = new LocalDiskObjectStore();
    await expect(store.putObject('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(
      /Invalid storage key/,
    );
  });

  it('getObjectStore()/getLocalObjectStore() is a process-wide singleton', () => {
    expect(getLocalObjectStore()).toBe(getLocalObjectStore());
  });

  describe('getPresignedPutUrl / getPresignedGetUrl', () => {
    it('produces a URL whose signature verifies for the matching method', async () => {
      const store = new LocalDiskObjectStore();
      const putUrl = await store.getPresignedPutUrl('uploads/conv-1/file-c', 'image/png', 60);
      const url = new URL(putUrl);
      const expires = Number(url.searchParams.get('expires'));
      const sig = url.searchParams.get('sig')!;

      expect(verifySignedRequest('PUT', 'uploads/conv-1/file-c', expires, sig)).toBe(true);
      // A GET-scoped verification of a PUT-signed URL must fail — the method is bound in.
      expect(verifySignedRequest('GET', 'uploads/conv-1/file-c', expires, sig)).toBe(false);
    });

    it('rejects an expired signature', async () => {
      const store = new LocalDiskObjectStore();
      const getUrl = await store.getPresignedGetUrl('uploads/conv-1/file-d', -10);
      const url = new URL(getUrl);
      const expires = Number(url.searchParams.get('expires'));
      const sig = url.searchParams.get('sig')!;

      expect(verifySignedRequest('GET', 'uploads/conv-1/file-d', expires, sig)).toBe(false);
    });

    it('rejects a tampered signature', async () => {
      const store = new LocalDiskObjectStore();
      const getUrl = await store.getPresignedGetUrl('uploads/conv-1/file-e', 60);
      const url = new URL(getUrl);
      const expires = Number(url.searchParams.get('expires'));

      expect(verifySignedRequest('GET', 'uploads/conv-1/file-e', expires, '0'.repeat(64))).toBe(
        false,
      );
    });

    it('rejects a signature minted for a different key', async () => {
      const store = new LocalDiskObjectStore();
      const getUrl = await store.getPresignedGetUrl('uploads/conv-1/file-f', 60);
      const url = new URL(getUrl);
      const expires = Number(url.searchParams.get('expires'));
      const sig = url.searchParams.get('sig')!;

      expect(verifySignedRequest('GET', 'uploads/conv-1/other-key', expires, sig)).toBe(false);
    });
  });
});
