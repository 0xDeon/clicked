import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, files } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { objectStore } from '../lib/objectStore.js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

export const filesRouter: IRouter = Router();
filesRouter.use(requireAuth);

const s3 = new S3Client({
  region: process.env['AWS_REGION'] || 'us-east-1',
});
const bucketName = process.env['AWS_BUCKET'] || 'clicked-files';

// ── POST /files/presign-upload ─────────────────────────────────────────────────
// Issues a presigned PUT URL so the client can upload encrypted ciphertext
// directly to S3 (#164).  A `files` row is created here so the backend has a
// record of the pending upload before the client sends the message envelope.
//
// Only ciphertext ever reaches S3 — the file key is carried exclusively inside
// the per-device E2EE envelopes attached to the subsequent send_message call.
filesRouter.post('/presign-upload', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const fileName =
    typeof req.body.fileName === 'string' ? req.body.fileName.trim() : undefined;
  const mimeType =
    typeof req.body.mimeType === 'string' ? req.body.mimeType.trim() : 'application/octet-stream';
  const sizeBytes =
    typeof req.body.sizeBytes === 'number' && req.body.sizeBytes > 0
      ? req.body.sizeBytes
      : undefined;

  if (!fileName) {
    res.status(400).json({ error: 'fileName is required' });
    return;
  }

  if (!sizeBytes) {
    res.status(400).json({ error: 'sizeBytes must be a positive number' });
    return;
  }

  // Max 100 MB per file
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  if (sizeBytes > MAX_FILE_BYTES) {
    res.status(413).json({ error: `File size exceeds maximum of ${MAX_FILE_BYTES} bytes` });
    return;
  }

  const fileId = randomUUID();
  // Storage key scoped by uploader to avoid collisions and enable per-user IAM
  const storageKey = `uploads/${userId}/${fileId}`;

  // Persist the file record before generating the presigned URL so the
  // message route can reference it by UUID.
  await db.insert(files).values({ id: fileId, storageKey });

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: storageKey,
      ContentType: mimeType,
      ContentLength: sizeBytes,
      // Server-side encryption as a defence-in-depth layer; the data is also
      // client-side AES-GCM encrypted so the two are complementary.
      ServerSideEncryption: 'AES256',
      Metadata: {
        'uploaded-by': userId,
        'original-filename': encodeURIComponent(fileName),
      },
    });

    // Presigned URL valid for 15 minutes — enough to encrypt + upload even
    // large files on slow connections.
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    res.status(201).json({ fileId, uploadUrl });
  } catch {
    // Roll back the file row so we don't leave a dangling record
    await db.delete(files).where(eq(files.id, fileId)).catch(() => {});
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ── GET /files/:fileId ─────────────────────────────────────────────────────────
// Issues a short-lived presigned GET URL so the client can download ciphertext
// and decrypt it locally (#166).  Access is gated on conversation membership.
filesRouter.get('/:fileId', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const fileId = req.params['fileId'] as string;

  if (!fileId) {
    res.status(400).json({ error: 'File id is required' });
    return;
  }

  // Resolve the file record
  const fileRecord = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!fileRecord || fileRecord.deletedAt) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  // Find the message that references this file and check conversation membership
  const message = await db.query.messages.findFirst({
    where: eq(messages.fileId, fileId),
  });

  if (!message) {
    res.status(404).json({ error: 'File not referenced by any message' });
    return;
  }

  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    // File may not yet be attached to a message (upload in progress) — deny.
    res.status(404).json({ error: 'File not found' });
    return;
  }

  // Check if the user is a member of the conversation where the file was shared
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, message.conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not authorized to access this file' });
    return;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: fileRecord.storageKey,
    });
    // Short-lived URL: 5 minutes
    const presignedUrl = await objectStore.getDownloadUrl(fileId, 300);
    res.json({ url: presignedUrl });
  } catch {
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

