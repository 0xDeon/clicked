/**
 * Integration tests for the local-storage route (#330) — proves presigned
 * URLs issued in dev/test are real, working URLs: a PUT followed by a GET
 * against the same signed URL round-trips actual bytes through the fs-backed
 * store, and requests with a missing/expired/tampered signature are refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import express from 'express';
import { localStorageRouter } from '../routes/localStorage.js';
import { getLocalObjectStore } from '../lib/localObjectStore.js';

let dir: string;
let originalDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-storage-route-'));
  originalDir = process.env['LOCAL_STORAGE_DIR'];
  process.env['LOCAL_STORAGE_DIR'] = dir;
});

afterEach(() => {
  if (originalDir === undefined) delete process.env['LOCAL_STORAGE_DIR'];
  else process.env['LOCAL_STORAGE_DIR'] = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

function buildApp() {
  const app = express();
  app.use('/local-storage', localStorageRouter);
  return app;
}

describe('local-storage route', () => {
  it('PUT then GET round-trips the uploaded bytes via presigned URLs', async () => {
    const app = buildApp();
    const store = getLocalObjectStore();
    const key = 'uploads/conv-1/round-trip';

    const putUrl = new URL(await store.getPresignedPutUrl(key, 'text/plain', 60));
    const putRes = await request(app)
      .put(putUrl.pathname + putUrl.search)
      .set('Content-Type', 'text/plain')
      .send(Buffer.from('payload bytes'));
    expect(putRes.status).toBe(200);

    const getUrl = new URL(await store.getPresignedGetUrl(key, 60));
    const getRes = await request(app).get(getUrl.pathname + getUrl.search);
    expect(getRes.status).toBe(200);
    expect(getRes.text).toBe('payload bytes');
    expect(getRes.headers['content-type']).toContain('text/plain');
  });

  it('rejects a GET with no signature', async () => {
    const app = buildApp();
    const res = await request(app).get('/local-storage/uploads/conv-1/missing-sig');
    expect(res.status).toBe(403);
  });

  it('rejects a GET with an expired signature', async () => {
    const app = buildApp();
    const store = getLocalObjectStore();
    const key = 'uploads/conv-1/expired';
    await store.putObject(key, Buffer.from('x'));

    const url = new URL(await store.getPresignedGetUrl(key, -30));
    const res = await request(app).get(url.pathname + url.search);
    expect(res.status).toBe(403);
  });

  it('rejects a GET whose signature was minted for a PUT', async () => {
    const app = buildApp();
    const store = getLocalObjectStore();
    const key = 'uploads/conv-1/wrong-method';
    await store.putObject(key, Buffer.from('x'));

    const putUrl = new URL(await store.getPresignedPutUrl(key, 'text/plain', 60));
    const res = await request(app).get(putUrl.pathname + putUrl.search);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a validly-signed GET of a key that was never written', async () => {
    const app = buildApp();
    const store = getLocalObjectStore();
    const key = 'uploads/conv-1/never-written';

    const url = new URL(await store.getPresignedGetUrl(key, 60));
    const res = await request(app).get(url.pathname + url.search);
    expect(res.status).toBe(404);
  });
});
