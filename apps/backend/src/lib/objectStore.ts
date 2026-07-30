import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv, type Env } from '../config.js';
import { getLocalObjectStore } from './localObjectStore.js';

/** Shape shared by the real S3-backed `ObjectStore` and the dev-only `LocalDiskObjectStore` (#330). */
export interface ObjectStoreLike {
  putObject(
    key: string,
    body: NonNullable<PutObjectCommandInput['Body']>,
    contentType?: string,
  ): Promise<void>;
  // Loose on purpose: the real S3 SDK response and the fs-backed store's
  // plain `{ Body, ContentType }` shape differ in exact optionality, and
  // nothing in this codebase consumes `getObject()` polymorphically today.
  getObject(key: string): Promise<unknown>;
  deleteObject(key: string): Promise<void>;
  getPresignedPutUrl(
    key: string,
    contentType: string | undefined,
    ttlSeconds: number,
  ): Promise<string>;
  getPresignedGetUrl(key: string, ttlSeconds: number): Promise<string>;
}

export type ObjectStoreConfig = Pick<
  Env,
  | 'OBJECT_STORE_ENDPOINT'
  | 'OBJECT_STORE_BUCKET'
  | 'OBJECT_STORE_ACCESS_KEY'
  | 'OBJECT_STORE_SECRET_KEY'
  | 'OBJECT_STORE_REGION'
  | 'OBJECT_STORE_FORCE_PATH_STYLE'
>;

/**
 * Build an S3-compatible client from env. The same configuration works against
 * local MinIO (path-style + custom endpoint), AWS S3, and Cloudflare R2 —
 * only the env values change.
 */
export function createObjectStoreClient(config: ObjectStoreConfig): S3Client {
  return new S3Client({
    endpoint: config.OBJECT_STORE_ENDPOINT,
    region: config.OBJECT_STORE_REGION,
    credentials: {
      accessKeyId: config.OBJECT_STORE_ACCESS_KEY,
      secretAccessKey: config.OBJECT_STORE_SECRET_KEY,
    },
    forcePathStyle: config.OBJECT_STORE_FORCE_PATH_STYLE,
  });
}

export class ObjectStore implements ObjectStoreLike {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async ensureBucketReachable(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async putObject(
    key: string,
    body: NonNullable<PutObjectCommandInput['Body']>,
    contentType?: string,
  ) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  /**
   * Checks whether an object exists at `key` and returns its size. Used to
   * verify an upload actually landed in the store before a file is marked
   * ready (#346). Works against both MinIO (local/dev) and AWS S3/R2
   * (production) — same HeadObject call either way.
   */
  async headObject(key: string): Promise<{ exists: boolean; size?: number }> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return result.ContentLength === undefined
        ? { exists: true }
        : { exists: true, size: result.ContentLength };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }

  async getObject(key: string) {
    return this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async deleteObject(key: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  /** Real, cryptographically-signed PUT URL — only ever called in production (#166). */
  async getPresignedPutUrl(key: string, contentType: string | undefined, ttlSeconds: number) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(contentType ? { ContentType: contentType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  /** Real, cryptographically-signed GET URL — only ever called in production (#166). */
  async getPresignedGetUrl(key: string, ttlSeconds: number) {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  return new ObjectStore(createObjectStoreClient(config), config.OBJECT_STORE_BUCKET);
}

// Lazily-constructed, process-wide singleton. `lib/storage.ts` and
// `services/fileCleanup.ts` both need the same configured client/bucket —
// building it here (rather than in `index.ts`) avoids a circular import
// (index.ts -> app.ts -> routes -> lib/storage.ts -> index.ts) and ensures
// there's exactly one S3 client/bucket pair for the whole process (#161/#168
// previously had three independent, inconsistently-configured ones).
//
// Outside production this resolves to a `LocalDiskObjectStore` (#330) instead
// of a real S3 client, so dev/test/CI never need a reachable S3/MinIO
// endpoint — every caller of `getObjectStore()` (storage.ts, fileCleanup.ts)
// transparently gets a real, working local implementation.
let singleton: ObjectStoreLike | null = null;

export function getObjectStore(): ObjectStoreLike {
  if (!singleton) {
    singleton =
      process.env['NODE_ENV'] === 'production'
        ? createObjectStore(loadEnv())
        : getLocalObjectStore();
  }
  return singleton;
}

/** Test-only: clears the memoized singleton so env changes take effect. */
export function resetObjectStoreForTests(): void {
  singleton = null;
}
