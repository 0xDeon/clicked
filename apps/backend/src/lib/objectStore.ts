import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv, type Env } from '../config.js';

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

export class ObjectStore {
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
let singleton: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (!singleton) {
    singleton = createObjectStore(loadEnv());
  }
  return singleton;
}
