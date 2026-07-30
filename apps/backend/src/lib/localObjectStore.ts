import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import type { ObjectStoreLike } from './objectStore.js';

/**
 * Pure-`fs` stand-in for the S3-backed `ObjectStore` (#330). Used whenever
 * `getObjectStore()` decides the process isn't running in production, so
 * local dev/CI can exercise the real upload -> presigned-URL -> download
 * round trip without Docker/MinIO. Bytes land under a gitignored directory;
 * "presigned" URLs point back at the local `/local-storage` route
 * (routes/localStorage.ts) and carry an HMAC-signed, time-limited token that
 * mirrors what a real presigned URL guarantees (method-bound, expiring,
 * tamper-evident) without needing any external service.
 */

const DEFAULT_ROOT_DIR = join(process.cwd(), '.local-storage');

// Only needs to be stable for the lifetime of one process: the same process
// that signs a URL is the one that verifies it when the request comes back in.
const processSecret = randomBytes(32).toString('hex');

function rootDir(): string {
  return process.env['LOCAL_STORAGE_DIR'] ?? DEFAULT_ROOT_DIR;
}

function baseUrl(): string {
  const configured = process.env['STORAGE_ENDPOINT'];
  if (configured) return configured.replace(/\/+$/, '');
  const port = process.env['PORT'] ?? '3001';
  return `http://localhost:${port}/local-storage`;
}

/** Resolves a storage key to an on-disk path, rejecting any traversal outside rootDir. */
function resolvePath(key: string): string {
  const root = rootDir();
  const resolved = normalize(join(root, key));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return resolved;
}

function metaPath(key: string): string {
  return `${resolvePath(key)}.meta.json`;
}

function sign(method: 'GET' | 'PUT', key: string, expires: number): string {
  return createHmac('sha256', processSecret).update(`${method}:${key}:${expires}`).digest('hex');
}

/** Verifies a signed local-storage URL's token/expiry. Used by routes/localStorage.ts. */
export function verifySignedRequest(
  method: 'GET' | 'PUT',
  key: string,
  expires: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expires) || Date.now() / 1000 > expires) return false;

  const expected = sign(method, key, expires);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

async function bodyToBuffer(body: NonNullable<PutObjectCommandInput['Body']>): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export class LocalDiskObjectStore implements ObjectStoreLike {
  async putObject(
    key: string,
    body: NonNullable<PutObjectCommandInput['Body']>,
    contentType?: string,
  ): Promise<void> {
    const path = resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await bodyToBuffer(body));
    await writeFile(metaPath(key), JSON.stringify({ contentType: contentType ?? null }));
  }

  async getObject(key: string): Promise<{ Body: Buffer; ContentType?: string }> {
    const path = resolvePath(key);
    const body = await readFile(path);
    const meta = await this.readMeta(key);
    return meta?.contentType ? { Body: body, ContentType: meta.contentType } : { Body: body };
  }

  async deleteObject(key: string): Promise<void> {
    await rm(resolvePath(key), { force: true });
    await rm(metaPath(key), { force: true });
  }

  async getPresignedPutUrl(
    key: string,
    _contentType: string | undefined,
    ttlSeconds: number,
  ): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = sign('PUT', key, expires);
    return `${baseUrl()}/${key}?expires=${expires}&sig=${sig}`;
  }

  async getPresignedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = sign('GET', key, expires);
    return `${baseUrl()}/${key}?expires=${expires}&sig=${sig}`;
  }

  /** Test/introspection helper — not part of ObjectStoreLike. */
  async exists(key: string): Promise<boolean> {
    try {
      await stat(resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  private async readMeta(key: string): Promise<{ contentType: string | null } | null> {
    try {
      return JSON.parse(await readFile(metaPath(key), 'utf8')) as { contentType: string | null };
    } catch {
      return null;
    }
  }
}

let singleton: LocalDiskObjectStore | null = null;

export function getLocalObjectStore(): LocalDiskObjectStore {
  if (!singleton) singleton = new LocalDiskObjectStore();
  return singleton;
}

export function resolveLocalStoragePath(key: string): string {
  return resolvePath(key);
}

export function localStorageMetaPath(key: string): string {
  return metaPath(key);
}
