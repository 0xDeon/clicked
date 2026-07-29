import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, files } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { generatePresignedGet } from '../lib/storage.js';
import { actorFromRequest, recordAuditEvent } from '../services/auditLog.js';

export const filesRouter: IRouter = Router();
filesRouter.use(requireAuth);

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

  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file || file.deletedAt) {
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

  // Check if the user is a member of the conversation where the file was shared
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, message.conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    // A non-member reaching for a file id is the clearest signal of an
    // attempt to read someone else's attachments (#376).
    void recordAuditEvent({
      action: 'file_access_denied',
      ...actorFromRequest(req),
      targetType: 'file',
      targetId: fileId,
      metadata: { conversationId: message.conversationId, reason: 'not_a_member' },
    });

    res.status(403).json({ error: 'Not authorized to access this file' });
    return;
  }

  try {
    // Short-lived URL: 5 minutes
    const presignedUrl = await generatePresignedGet(file.storageKey, 300);
    res.json({ url: presignedUrl });
  } catch {
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});
