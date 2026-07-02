import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createObjectStore, createObjectStoreClient } from '../lib/objectStore.js';

const config = {
  OBJECT_STORE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORE_BUCKET: 'clicked',
  OBJECT_STORE_ACCESS_KEY: 'clicked',
  OBJECT_STORE_SECRET_KEY: 'clickedsecret',
  OBJECT_STORE_REGION: 'us-east-1',
  OBJECT_STORE_FORCE_PATH_STYLE: true,
};

describe('createObjectStoreClient', () => {
  it('configures the S3 client for path-style MinIO endpoints', () => {
    const client = createObjectStoreClient(config);
    expect(client).toBeInstanceOf(S3Client);
    expect(client.config.endpoint).toBeDefined();
  });

  it('supports virtual-hosted AWS/R2 style endpoints when path style is disabled', () => {
    const client = createObjectStoreClient({
      ...config,
      OBJECT_STORE_ENDPOINT: 'https://s3.amazonaws.com',
      OBJECT_STORE_FORCE_PATH_STYLE: false,
    });
    expect(client).toBeInstanceOf(S3Client);
  });
});

describe('ObjectStore', () => {
  const send = vi.fn();

  beforeEach(() => {
    send.mockReset();
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(send);
  });

  it('checks bucket reachability with HeadBucket', async () => {
    send.mockResolvedValue({});
    const store = createObjectStore(config);

    await store.ensureBucketReachable();

    expect(send).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
  });

  it('uploads, reads, and deletes objects in the configured bucket', async () => {
    send.mockResolvedValue({});
    const store = createObjectStore(config);

    await store.putObject('avatars/user.png', Buffer.from('png'), 'image/png');
    await store.getObject('avatars/user.png');
    await store.deleteObject('avatars/user.png');

    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'clicked',
          Key: 'avatars/user.png',
          ContentType: 'image/png',
        }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, expect.any(GetObjectCommand));
    expect(send).toHaveBeenNthCalledWith(3, expect.any(DeleteObjectCommand));
  });
});
