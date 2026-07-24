import { Router } from 'express';
import type { IRouter } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageEnvelopes, devices } from '../db/schema.js';
import { softDeleteFile } from '../services/fileCleanup.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { getSocketServer } from '../lib/socket.js';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';
import { SendMessageSchema } from '../schemas/message.schemas.js';

export const messagesRouter: IRouter = Router();

messagesRouter.use(requireAuth);

// ── POST /messages ─────────────────────────────────────────────────────────────
// REST send path – mirrors the WebSocket `send_message` handler.
// Both paths share `validateMessagePayload` for content-type-specific rules.
messagesRouter.post('/', validate(SendMessageSchema), async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const deviceId = req.auth!.deviceId as string | undefined;
  const { conversationId, messageId, contentType, ciphertext, envelopes, fileId } = req.body as {
    conversationId: string;
    messageId: string;
    contentType?: string;
    ciphertext?: string;
    envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
    fileId?: string;
  };

  // ── content-type-specific validation ──────────────────────────────────────
  const validation = validateMessagePayload({
    ...(contentType !== undefined ? { contentType } : {}),
    ...(ciphertext !== undefined ? { ciphertext } : {}),
    ...(envelopes !== undefined ? { envelopes } : {}),
    ...(fileId !== undefined ? { fileId } : {}),
  });
  if (!validation.ok) {
    res.status(validation.code).json({ error: validation.message });
    return;
  }

  // ── membership check ───────────────────────────────────────────────────────
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

  // ── idempotency ────────────────────────────────────────────────────────────
  const existing = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    columns: { createdAt: true },
  });

  if (existing) {
    res.status(200).json({ messageId, createdAt: existing.createdAt });
    return;
  }

  // ── persist in transaction ─────────────────────────────────────────────────
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
        })
        .returning();

      if (envelopes && envelopes.length > 0) {
        const deviceIds = envelopes.map((e) => e.recipientDeviceId);
        const devicesList = await tx.query.devices.findMany({
          where: inArray(devices.id, deviceIds),
          columns: { id: true, userId: true },
        });
        const deviceToUser = new Map(devicesList.map((d) => [d.id, d.userId]));

        const validEnvelopes = envelopes
          .filter((env) => deviceToUser.has(env.recipientDeviceId))
          .map((env) => ({
            messageId,
            recipientDeviceId: env.recipientDeviceId,
            recipientUserId: deviceToUser.get(env.recipientDeviceId)!,
            ciphertext: env.ciphertext,
          }));

        if (validEnvelopes.length > 0) {
          await tx.insert(messageEnvelopes).values(validEnvelopes);
        }
      }

      return insertedMessage;
    });
  } catch (error) {
    console.error('Transaction failed for message insert:', error);
    res.status(500).json({ error: 'Failed to persist message' });
    return;
  }

  // ── broadcast via Socket.IO ────────────────────────────────────────────────
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

// ── DELETE /messages/:id ───────────────────────────────────────────────────────
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

  // #231 – soft-delete file record when message has a file attachment
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
