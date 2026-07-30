import { Router } from 'express';
import type { IRouter } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { files, conversationMembers } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { generatePresignedPut, generateStorageKey } from '../lib/storage.js';
import { getGroupByConversation, isActiveMember } from '../services/mlsGroups.js';

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

  // ── MLS group uploads (#371) ────────────────────────────────────────────────
  // The file is encrypted once to a random file key, and that key is delivered
  // by putting it inside the MLS group message that references the file — so
  // the uploading device has to be able to send into the group in the first
  // place. `mlsEpoch` comes back with the slot so the client knows which epoch
  // to encrypt that message to.
  const group = await getGroupByConversation(conversationId);
  const deviceId = req.auth!.deviceId as string | undefined;

  if (group) {
    if (!deviceId || !(await isActiveMember(group.id, deviceId))) {
      res.status(403).json({ error: 'Device is not a member of this conversation MLS group' });
      return;
    }
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

  res.status(201).json({ fileId: file!.id, uploadUrl, mlsEpoch: group?.currentEpoch ?? null });
});

// POST /uploads/:fileId/confirm — mark file as ready after client PUT succeeds
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

  await db.update(files).set({ status: 'ready' }).where(eq(files.id, fileId));

  res.status(200).json({ fileId, status: 'ready' });
});
