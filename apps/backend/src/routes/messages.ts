import { Router } from 'express';
import type { IRouter } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageEnvelopes } from '../db/schema.js';
import { softDeleteFile } from '../services/fileCleanup.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { getSocketServer } from '../lib/socket.js';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';
import { SendMessageSchema } from '../schemas/message.schemas.js';
import { checkEnvelopeProtocols, type E2eeProtocol } from '../services/e2eeProtocol.js';
import { insertMessageEnvelopes } from '../lib/messageFanout.js';
import { BASELINE_PROTOCOL } from '../lib/capabilities.js';

export const messagesRouter: IRouter = Router();

messagesRouter.use(requireAuth);

type MembershipChange = {
  phase?: 'proposal' | 'commit';
  kind?: 'proposal' | 'commit';
  action?: 'add' | 'remove';
  operation?: 'add' | 'remove';
  userId?: string;
  memberId?: string;
  targetUserId?: string;
};

function membershipChangeFromBody(body: Record<string, unknown>): MembershipChange | undefined {
  const value = body['membershipChange'];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as MembershipChange;
  }

  const action = body['membershipAction'] ?? body['membershipOperation'];
  const targetUserId = body['membershipUserId'] ?? body['memberId'];
  const phase = body['membershipPhase'] ?? body['membershipKind'];
  if (
    (action === 'add' || action === 'remove') &&
    typeof targetUserId === 'string' &&
    (phase === 'proposal' || phase === 'commit')
  ) {
    return { action, phase, userId: targetUserId };
  }

  return undefined;
}

function isCommit(change: MembershipChange): boolean {
  return change.phase === 'commit' || change.kind === 'commit';
}

function membershipAction(change: MembershipChange): 'add' | 'remove' | undefined {
  const action = change.action ?? change.operation;
  return action === 'add' || action === 'remove' ? action : undefined;
}

function membershipTarget(change: MembershipChange): string | undefined {
  const target = change.userId ?? change.memberId ?? change.targetUserId;
  return typeof target === 'string' && target.length > 0 ? target : undefined;
}

async function applyMembershipCommit(
  tx: any,
  conversationId: string,
  change: MembershipChange,
): Promise<void> {
  const action = membershipAction(change);
  const targetUserId = membershipTarget(change);
  if (!action || !targetUserId) return;

  if (action === 'remove') {
    await tx
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      );
    return;
  }

  const existing = await tx.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, targetUserId),
    ),
  });

  if (!existing) {
    await tx.insert(conversationMembers).values({
      conversationId,
      userId: targetUserId,
    });
  }
}

messagesRouter.post('/', validate(SendMessageSchema), async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const deviceId = req.auth!.deviceId as string | undefined;
  const body = req.body as Record<string, unknown>;
  const { conversationId, messageId, contentType, ciphertext, envelopes, fileId, mlsEpoch } =
    body as {
      conversationId: string;
      messageId: string;
      contentType?: string;
      ciphertext?: string;
      envelopes?: Array<{
        recipientDeviceId: string;
        ciphertext: string;
        protocol?: E2eeProtocol;
      }>;
      fileId?: string;
      mlsEpoch?: number;
    };
  const membershipChange = membershipChangeFromBody(body);

  if (membershipChange) {
    const action = membershipAction(membershipChange);
    const target = membershipTarget(membershipChange);
    const phase = membershipChange.phase ?? membershipChange.kind;
    if (!action || !target || (phase !== 'proposal' && phase !== 'commit')) {
      res.status(400).json({ error: 'Invalid membership change metadata' });
      return;
    }
  }

  const validation = validateMessagePayload({
    ...(contentType !== undefined ? { contentType } : {}),
    ...(ciphertext !== undefined ? { ciphertext } : {}),
    ...(envelopes !== undefined ? { envelopes } : {}),
    ...(fileId !== undefined ? { fileId } : {}),
    ...(mlsEpoch !== undefined ? { mlsEpoch } : {}),
  });
  if (!validation.ok) {
    res.status(validation.code).json({ error: validation.message });
    return;
  }

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

  // ── E2EE protocol enforcement (#364) ───────────────────────────────────────
  // Rejects an envelope naming a protocol its recipient cannot decrypt, and a
  // fallback weaker than what both devices support.
  if (envelopes && envelopes.length > 0) {
    const protocolCheck = await checkEnvelopeProtocols(
      deviceId,
      envelopes.map((e) => ({
        recipientDeviceId: e.recipientDeviceId,
        protocol: e.protocol ?? BASELINE_PROTOCOL,
      })),
    );

    if (!protocolCheck.ok) {
      res.status(protocolCheck.code).json({
        error: protocolCheck.error,
        violations: protocolCheck.violations,
      });
      return;
    }
  }

  // ── idempotency ────────────────────────────────────────────────────────────
  const existing = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { createdAt: true },
  });

  if (existing) {
    res.status(200).json({ messageId, createdAt: existing.createdAt });
    return;
  }

  let message;
  try {
    message = await db.transaction(async (tx) => {
      const [insertedMessage] = await tx
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          senderId: userId,
          senderDeviceId: deviceId ?? null,
          contentType: contentType?.trim().toLowerCase() || 'text',
          ciphertext: ciphertext || null,
          fileId: fileId ?? null,
          mlsEpoch: mlsEpoch ?? null,
        })
        .returning();

      // Shared with the socket send paths (#188/#337) so the per-envelope
      // protocol default cannot drift between the two implementations.
      await insertMessageEnvelopes(tx, messageId, envelopes);

      if (membershipChange && isCommit(membershipChange)) {
        await applyMembershipCommit(tx, conversationId, membershipChange);
      }

      return insertedMessage;
    });
  } catch (error) {
    console.error('Transaction failed for message insert:', error);
    res.status(500).json({ error: 'Failed to persist message' });
    return;
  }

  if (message) {
    getSocketServer()?.to(conversationId).emit('new_message', message);
  }

  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });

  await invalidateConversationCaches(members.map((member) => member.userId));
  res.status(201).json(message);
});

messagesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const messageId = req.params['id'] as string | undefined;

  if (!messageId) {
    res.status(400).json({ error: 'Message id is required' });
    return;
  }

  const message = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });

  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  if (message.senderId !== userId) {
    res.status(403).json({ error: 'You can only delete your own messages' });
    return;
  }

  await db
    .update(messages)
    .set({ deletedAt: new Date(), ciphertext: null })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, userId)));

  await db.delete(messageEnvelopes).where(eq(messageEnvelopes.messageId, messageId));

  if (message.fileId) {
    await softDeleteFile(message.fileId);
  }

  getSocketServer()?.to(message.conversationId).emit('message_deleted', {
    messageId: message.id,
    conversationId: message.conversationId,
  });

  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, message.conversationId),
    columns: { userId: true },
  });

  await invalidateConversationCaches(members.map((member) => member.userId));
  res.status(204).send();
});
