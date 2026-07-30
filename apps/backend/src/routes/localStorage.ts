import { Router } from 'express';
import type { IRouter, Request, Response } from 'express';
import express from 'express';
import { getLocalObjectStore, verifySignedRequest } from '../lib/localObjectStore.js';

/**
 * Dev/test-only route (#330) that serves GET/PUT against the fs-backed
 * `LocalDiskObjectStore`, so presigned URLs issued in development are real,
 * working URLs instead of a never-dereferenced string template. Mirrors the
 * two operations a real presigned S3 URL supports — nothing else — and is
 * gated by the same HMAC signature + expiry a presigned URL relies on, since
 * this route intentionally sits outside `requireAuth` (see app.ts).
 */
export const localStorageRouter: IRouter = Router();

function keyFromSplat(req: Request): string | undefined {
  const splat = req.params['splat'];
  if (Array.isArray(splat)) return splat.join('/');
  return typeof splat === 'string' ? splat : undefined;
}

function checkSignature(req: Request, res: Response, method: 'GET' | 'PUT'): string | null {
  const key = keyFromSplat(req);
  const expires = Number(req.query['expires']);
  const sig = req.query['sig'];

  if (!key || typeof sig !== 'string' || !verifySignedRequest(method, key, expires, sig)) {
    res.status(403).json({ error: 'Invalid or expired signed URL' });
    return null;
  }
  return key;
}

localStorageRouter.put(
  '/*splat',
  express.raw({ type: () => true, limit: '150mb' }),
  async (req: Request, res: Response) => {
    const key = checkSignature(req, res, 'PUT');
    if (!key) return;

    const contentType = req.headers['content-type'];
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    try {
      await getLocalObjectStore().putObject(
        key,
        body,
        typeof contentType === 'string' ? contentType : undefined,
      );
      res.status(200).end();
    } catch {
      res.status(500).json({ error: 'Failed to store object' });
    }
  },
);

localStorageRouter.get('/*splat', async (req: Request, res: Response) => {
  const key = checkSignature(req, res, 'GET');
  if (!key) return;

  try {
    const { Body, ContentType } = await getLocalObjectStore().getObject(key);
    if (ContentType) res.setHeader('Content-Type', ContentType);
    res.status(200).send(Body as Buffer);
  } catch {
    res.status(404).json({ error: 'Object not found' });
  }
});
