import { Router } from 'express';
import type { IRouter } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { files, conversationMembers } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { generatePresignedPut, generateStorageKey } from '../lib/storage.js';
import { verifyFileIntegrity } from '../lib/fileIntegrity.js';

export const uploadsRouter: IRouter = Router();

uploadsRouter.use(requireAuth);

const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'application/pdf',
  'application/octet-stream',
]);

const RequestSlotSchema = z.object({
  conversationId: z.string().uuid(),
  size: z.number().int().positive().max(MAX_SIZE_BYTES),
  mimeType: z.string().min(1),
  sha256: z.string().min(1),
  isThumbnail: z.boolean().optional().default(false),
});

// POST /uploads — request a presigned upload slot
uploadsRouter.post('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const parsed = RequestSlotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { conversationId, size, mimeType, sha256, isThumbnail } = parsed.data;

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    res.status(415).json({ error: 'Unsupported media type', mimeType });
    return;
  }

  // Caller must be a member of the conversation
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const storageKey = generateStorageKey(conversationId, sha256);
  const uploadUrl = await generatePresignedPut(storageKey, mimeType);

  const [file] = await db
    .insert(files)
    .values({
      uploaderId: userId,
      conversationId,
      status: 'pending',
      size,
      mimeType,
      sha256,
      storageKey,
      isThumbnail,
    })
    .returning({ id: files.id });

  res.status(201).json({ fileId: file!.id, uploadUrl });
});

// POST /uploads/:fileId/confirm — mark file as ready after client PUT succeeds
//
// SECURITY FIX: Now performs SHA-256 integrity verification before marking ready.
// If hash mismatch is detected, the file is marked as corrupted and never becomes ready.
uploadsRouter.post('/:fileId/confirm', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const fileId = req.params['fileId'] as string;

  if (!fileId) {
    res.status(400).json({ error: 'fileId is required' });
    return;
  }

  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  if (file.uploaderId !== userId) {
    res.status(403).json({ error: 'Not authorized to confirm this upload' });
    return;
  }

  if (file.status === 'ready') {
    res.status(409).json({ error: 'File is already ready' });
    return;
  }

  if (file.status === 'deleted') {
    res.status(409).json({ error: 'File has been deleted' });
    return;
  }

  // SECURITY FIX: Verify SHA-256 integrity before marking ready
  const integrityCheck = await verifyFileIntegrity(file.storageKey, file.sha256);

  if (!integrityCheck.valid) {
    // Mark file as corrupted/failed — never becomes ready
    await db
      .update(files)
      .set({ 
        status: 'deleted', // Mark as deleted to prevent usage
        deletedAt: new Date(),
      })
      .where(eq(files.id, fileId));

    res.status(422).json({
      error: 'File integrity verification failed',
      details: {
        reason: integrityCheck.error || 'Hash mismatch',
        expectedHash: integrityCheck.expectedHash,
        computedHash: integrityCheck.computedHash,
      },
    });
    return;
  }

  // Integrity verified — mark as ready
  await db.update(files).set({ status: 'ready' }).where(eq(files.id, fileId));

  res.status(200).json({ fileId, status: 'ready' });
});
