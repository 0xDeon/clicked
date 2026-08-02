import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, conversationMembers, files } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { generatePresignedGet } from '../lib/storage.js';
import { mlsUnavailableReason, type MlsUnavailableReason } from '../lib/mlsVisibility.js';
import { getConversationEpochWindow } from '../services/mlsGroups.js';
import { actorFromRequest, recordAuditEvent } from '../services/auditLog.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const filesRouter: IRouter = Router();
filesRouter.use(requireAuth);

// ── GET /files/:fileId ─────────────────────────────────────────────────────────
// Issues a short-lived presigned GET URL so the client can download ciphertext
// and decrypt it locally (#166). Access is gated on conversation membership,
// and — for files shared into an MLS group (#371) — on the requesting device
// holding the epoch the file key was distributed in.
//
// A group file is encrypted once, to a random file key, and that key travels
// inside the MLS group message that references it. The server stores the single
// ciphertext and never sees the key, so "who can open this file" is decided by
// who could decrypt the message that carried the key. This route mirrors that
// decision rather than inventing a second, weaker rule.
filesRouter.get('/:fileId', rateLimit('file_download'), async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const deviceId = req.auth!.deviceId as string | undefined;
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

  // All messages that reference this file. Usually one, but a file re-shared
  // into a later epoch has several — and that is precisely how a group makes an
  // older file readable to members who joined later, so every reference has to
  // be considered rather than just the first.
  const referencing = await db.query.messages.findMany({
    where: eq(messages.fileId, fileId),
    columns: { id: true, conversationId: true, mlsEpoch: true },
  });

  if (referencing.length === 0) {
    res.status(404).json({ error: 'File not referenced by any message' });
    return;
  }

  // Check if the user is a member of the conversation where the file was shared
  const conversationIds = [...new Set(referencing.map((m) => m.conversationId))];
  const memberships = await Promise.all(
    conversationIds.map((conversationId) =>
      db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
        columns: { id: true },
      }),
    ),
  );

  const memberOf = new Set(conversationIds.filter((_, index) => Boolean(memberships[index])));

  const reachable = referencing.filter((m) => memberOf.has(m.conversationId));

  if (reachable.length === 0) {
    // A non-member reaching for a file id is the clearest signal of an
    // attempt to read someone else's attachments (#376).
    void recordAuditEvent({
      action: 'file_access_denied',
      ...actorFromRequest(req),
      targetType: 'file',
      targetId: fileId,
      metadata: { conversationId: referencing[0]!.conversationId, reason: 'not_a_member' },
    });

    res.status(403).json({ error: 'Not authorized to access this file' });
    return;
  }

  // ── MLS epoch check (#371) ──────────────────────────────────────────────────
  // Access is granted if *any* reachable reference sits inside this device's
  // epoch window. A device removed from the group at epoch M keeps whatever it
  // could already decrypt and loses everything shared from M on: the removal
  // commit rekeys the group, so it never receives the file keys distributed
  // afterwards, and this check stops the server handing out the ciphertext they
  // protect.
  const mlsReferences = reachable.filter((m) => m.mlsEpoch !== null);
  const nonMlsReferences = reachable.length - mlsReferences.length;

  let grantedEpoch: number | null = null;
  let denialReason: MlsUnavailableReason | null = null;

  if (nonMlsReferences === 0 && mlsReferences.length > 0) {
    for (const reference of mlsReferences) {
      const { window } = await getConversationEpochWindow(reference.conversationId, deviceId);
      const reason = mlsUnavailableReason(reference.mlsEpoch!, window);

      if (reason === null) {
        grantedEpoch = reference.mlsEpoch;
        break;
      }

      // Report the reason from the earliest reference so the message is about
      // the original share rather than an incidental re-share.
      denialReason ??= reason;
    }

    if (grantedEpoch === null) {
      res.status(403).json({
        error: 'This device has no key for this file',
        reason: denialReason,
      });
      return;
    }
  }

  try {
    // Short-lived URL: 5 minutes
    const presignedUrl = await generatePresignedGet(file.storageKey, 300);
    res.json({ url: presignedUrl, mlsEpoch: grantedEpoch });
  } catch {
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});
