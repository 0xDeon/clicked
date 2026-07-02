import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import type { Env } from '../config.js';

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

  async putObject(key: string, body: NonNullable<PutObjectCommandInput['Body']>, contentType?: string) {
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
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  return new ObjectStore(createObjectStoreClient(config), config.OBJECT_STORE_BUCKET);
}
