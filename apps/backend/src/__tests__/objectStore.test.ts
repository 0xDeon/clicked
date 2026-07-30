import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  createObjectStore,
  createObjectStoreClient,
  getObjectStore,
  resetObjectStoreForTests,
} from '../lib/objectStore.js';
import { LocalDiskObjectStore } from '../lib/localObjectStore.js';

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

  describe('headObject', () => {
    it('returns exists: true and the object size when the object is present', async () => {
      send.mockResolvedValue({ ContentLength: 4096 });
      const store = createObjectStore(config);

      const result = await store.headObject('uploads/conv-1/key');

      expect(send).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
      expect(result).toEqual({ exists: true, size: 4096 });
    });

    it('returns exists: false when the SDK throws a NotFound error', async () => {
      send.mockRejectedValue(Object.assign(new Error('not found'), { name: 'NotFound' }));
      const store = createObjectStore(config);

      const result = await store.headObject('uploads/conv-1/missing');

      expect(result).toEqual({ exists: false });
    });

    it('returns exists: false when the SDK throws a NoSuchKey error', async () => {
      send.mockRejectedValue(Object.assign(new Error('no such key'), { name: 'NoSuchKey' }));
      const store = createObjectStore(config);

      const result = await store.headObject('uploads/conv-1/missing');

      expect(result).toEqual({ exists: false });
    });

    it('returns exists: false when the SDK throws with a 404 status code', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }),
      );
      const store = createObjectStore(config);

      const result = await store.headObject('uploads/conv-1/missing');

      expect(result).toEqual({ exists: false });
    });

    it('re-throws unrelated errors instead of treating them as not-found', async () => {
      send.mockRejectedValue(new Error('network error'));
      const store = createObjectStore(config);

      await expect(store.headObject('uploads/conv-1/key')).rejects.toThrow('network error');
    });
  });
});

describe('getObjectStore() environment selection (#330)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetObjectStoreForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetObjectStoreForTests();
  });

  it('resolves to the local-disk store outside production', () => {
    process.env['NODE_ENV'] = 'test';
    expect(getObjectStore()).toBeInstanceOf(LocalDiskObjectStore);
  });

  it('resolves to the real S3-backed store in production', () => {
    process.env['NODE_ENV'] = 'production';
    // getObjectStore() validates the full env via loadEnv() in production —
    // supply everything EnvSchema requires, not just OBJECT_STORE_*.
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['PORT'] = '3001';
    process.env['TOKEN_TRANSFER_CONTRACT_ID'] = 'CONTRACT123';

    const store = getObjectStore();
    expect(store).not.toBeInstanceOf(LocalDiskObjectStore);
    expect(store.constructor.name).toBe('ObjectStore');
  });
});
