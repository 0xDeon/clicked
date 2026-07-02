import type { Server } from 'socket.io';
import { createHash } from 'node:crypto';
import { and, eq, lt, desc, sql, inArray, isNull, ne } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  conversations,
  conversationMembers,
  messages,
  messageEnvelopes,
  userDevices,
  files,
} from '../db/schema.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';
import { sendPushForMessage } from '../services/push.js';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';
import { dispatchOfflinePush, FILE_CONTENT_TYPES } from '../services/pushNotification.js';
import { deliverMessage } from '../services/deliveryPipeline.js';
import { publishEphemeral, readMissedEvents } from '../services/resumeStream.js';
import { publishToDevice } from '../services/deviceDelivery.js';
import { EventDispatcher } from './dispatcher.js';

const PAGE_SIZE = 30;

/**
 * Returns the UUIDs of all active (non-revoked) user_devices that belong to
 * `userId` but are NOT the sending device (`senderDeviceId`). These are the
 * "sibling" devices that must each receive their own envelope so they can
 * decrypt the message locally. Issue #188.
 */
async function fetchSiblingDeviceIds(userId: string, senderDeviceId: string): Promise<string[]> {
  const siblings = await db.query.userDevices.findMany({
    where: and(
      eq(userDevices.userId, userId),
      ne(userDevices.id, senderDeviceId),
      isNull(userDevices.revokedAt),
    ),
    columns: { id: true },
  });
  return siblings.map((d) => d.id);
}

export function registerMessagingHandlers(io: Server, socket: AuthSocket): void {
  const userId = socket.auth!.userId;
  const dispatcher = new EventDispatcher(io, socket, redis);
  const typingTimers = new Map<string, NodeJS.Timeout>();

  socket.on('disconnect', () => {
    for (const [timerKey, timer] of typingTimers.entries()) {
      clearTimeout(timer);
      const idx = timerKey.indexOf(':');
      const cid = idx === -1 ? timerKey : timerKey.slice(0, idx);
      const did = idx === -1 ? undefined : timerKey.slice(idx + 1);
      const rp: { conversationId: string; userId: string; deviceId?: string } = {
        conversationId: cid,
        userId,
      };
      if (did) rp.deviceId = did;
      socket.to(cid).emit('typing_stop', rp);
    }
    typingTimers.clear();
  });

  // ── join_room ──────────────────────────────────────────────────────────────
  dispatcher.register('join_room', async (payload) => {
    const { conversationId } = payload as { conversationId: string };

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'join_room', message: 'Not a member of this conversation' });
      return;
    }

    await socket.join(conversationId);
    socket.emit('room_joined', { conversationId });
  });

  // ── send_message ───────────────────────────────────────────────────────────
  dispatcher.register('send_message', async (payload) => {
    const { conversationId, messageId, content, contentType, ciphertext, envelopes, fileId } = payload as {
      conversationId: string;
      messageId?: string;
      content?: string;
      contentType?: string;
      ciphertext?: string;
      ciphertextSha256?: string;
      envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
      fileId?: string;
    };
    const deviceId = socket.auth!.deviceId;

    // Clear active typing state as soon as the member attempts to send.
    for (const [timerKey, timer] of typingTimers.entries()) {
      if (timerKey === conversationId || timerKey.startsWith(`${conversationId}:`)) {
        clearTimeout(timer);
        typingTimers.delete(timerKey);
        const idx = timerKey.indexOf(':');
        const did = idx === -1 ? undefined : timerKey.slice(idx + 1);
        const rp: { conversationId: string; userId: string; deviceId?: string } = {
          conversationId,
          userId,
        };
        if (did) rp.deviceId = did;
        socket.to(conversationId).emit('typing_stop', rp);
      }
    }

    if (!messageId) {
      socket.emit('error', { event: 'send_message', message: 'messageId is required' });
      return;
    }

    const effectiveCiphertext = ciphertext ?? content ?? undefined;

    const validation = validateMessagePayload({

      ...(contentType !== undefined ? { contentType } : {}),
      ...(effectiveCiphertext !== undefined ? { ciphertext: effectiveCiphertext } : {}),
      ...(envelopes !== undefined ? { envelopes } : {}),
      ...(fileId !== undefined ? { fileId } : {}),

      contentType,
      ciphertext: effectiveCiphertext,
      envelopes,
      fileId: payloadFileId,

    });
    if (!validation.ok) {
      socket.emit('error', {
        event: 'send_message',
        code: validation.code,
        message: validation.message,
      });
      return;
    }

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'send_message', message: 'Not a member of this conversation' });
      return;
    }

    const existing = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { sequenceNumber: true },
    });

    if (existing) {
      socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
      return;
    }

    // Enforce full sibling-device coverage (#188).
    const siblingIds = await fetchSiblingDeviceIds(userId, deviceId);
    if (siblingIds.length > 0) {
      const providedIds = new Set(envelopes?.map((e) => e.recipientDeviceId) ?? []);
      const missing = siblingIds.filter((id) => !providedIds.has(id));
      if (missing.length > 0) {
        socket.emit('error', {
          event: 'device_set_mismatch',
          message: `Missing envelopes for ${missing.length} sibling device(s)`,
          missingDeviceIds: missing,
        });
        return;
      }
    }

    let fileId: string | undefined = payloadFileId;
    const resolvedContentType = contentType || 'text/plain';
    if (FILE_CONTENT_TYPES.has(resolvedContentType)) {

      const [fileRow] = await db
        .insert(files)
        .values({ storageKey: messageId })
        .onConflictDoUpdate({ target: files.storageKey, set: { storageKey: messageId } })
        .returning({ id: files.id });

      persistedFileId = fileRow?.id;

      fileId = fileRow?.id ?? payloadFileId;

    }

    const [message] = await db
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        senderId: userId,
        senderDeviceId: deviceId,
        contentType: resolvedContentType,
        ciphertext: effectiveCiphertext,
        fileId: persistedFileId ?? null,
      })
      .returning();

    let recipientDeviceIds: string[] = [];
    try {
      message = await db.transaction(async (tx) => {
        const [insertedMessage] = await tx
          .insert(messages)
          .values({
            id: messageId,
            conversationId,
            senderId: userId,
            senderDeviceId: deviceId,
            contentType: resolvedContentType,
            ciphertext: effectiveCiphertext,
            fileId: fileId ?? null,
          })
          .returning();

        if (envelopes && envelopes.length > 0) {
          const deviceIds = envelopes.map((e) => e.recipientDeviceId);
          const devicesList = await tx.query.userDevices.findMany({
            where: inArray(userDevices.id, deviceIds),
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
            recipientDeviceIds = validEnvelopes.map((e) => e.recipientDeviceId);
          }
        }

        return insertedMessage;
      });
    } catch (error) {
      console.error('Transaction failed for message insert:', error);
      socket.emit('error', { event: 'send_message', message: 'Failed to persist message' });
      return;
    }

    if (!message) {
      socket.emit('error', { event: 'send_message', message: 'Failed to persist message' });
      return;
    }

    socket.emit('message_ack', { messageId, sequenceNumber: message.sequenceNumber });

    // Publish to Redis after transaction commit
    if (redis && envelopes && envelopes.length > 0) {
      const deviceIds = envelopes.map((e) => e.recipientDeviceId);
      const devicesList = await db.query.userDevices.findMany({
        where: inArray(userDevices.id, deviceIds),
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

      for (const env of validEnvelopes) {
        publishToDevice(redis, env.recipientDeviceId, {
          messageId: message.id,
          conversationId,
          ciphertext: env.ciphertext,
          sequenceNumber: message.sequenceNumber,
        }).catch(() => {});
      }
    }

    if (!message) {
      socket.emit('error', { event: 'send_message', message: 'Failed to persist message' });
      return;
    }

    if (message) {
      await deliverMessage(io, message, conversationId);
    }

    socket.emit('message_ack', { messageId, sequenceNumber: message.sequenceNumber });

    await deliverMessage(io, message, conversationId);


    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));

    void dispatchOfflinePush(conversationId, messageId, recipientDeviceIds);
  });

  // ── edit_message ───────────────────────────────────────────────────────────
  dispatcher.register('edit_message', async (payload) => {
    const { originalMessageId, messageId, contentType, ciphertext, envelopes } = payload as {
      originalMessageId: string;
      messageId: string;
      contentType?: string;
      ciphertext?: string;
      envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
    };
    const deviceId = socket.auth!.deviceId;

    if (!originalMessageId || !messageId) {
      socket.emit('error', {
        event: 'edit_message',
        message: 'originalMessageId and messageId are required',
      });
      return;
    }

    if (!ciphertext?.trim() && (!envelopes || envelopes.length === 0)) {
      socket.emit('error', { event: 'edit_message', message: 'Message content is empty' });
      return;
    }

      // Verify ciphertext integrity when a sha256 is provided.
      if (ciphertextSha256 && ciphertext) {
        const computed = createHash('sha256').update(ciphertext, 'utf8').digest('hex');
        if (computed !== ciphertextSha256) {
          socket.emit('error', {
            event: 'integrity_error',
            message: 'Ciphertext sha256 mismatch',
          });
          return;
        }
      }

      const [message] = await db
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          senderId: userId,
          senderDeviceId: deviceId,
          contentType: contentType || 'text/plain',
          ciphertext: effectiveCiphertext,
        })
        .returning();
    const original = await db.query.messages.findFirst({
      where: eq(messages.id, originalMessageId),
    });

    if (!original) {
      socket.emit('error', { event: 'edit_message', message: 'Original message not found' });
      return;
    }

    if (original.senderId !== userId) {
      socket.emit('error', {
        event: 'edit_message',
        message: 'Only the original sender can edit this message',
      });
      return;
    }

    const rootMessageId = original.editsMessageId ?? original.id;
    const conversationId = original.conversationId;

    const existing = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { sequenceNumber: true },
    });

    if (existing) {
      socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
      return;
    }

    let message;
    let recipientDeviceIds: string[] = [];
    try {
      message = await db.transaction(async (tx) => {
        const [insertedMessage] = await tx
          .insert(messages)
          .values({
            id: messageId,
            conversationId,
            senderId: userId,
            senderDeviceId: deviceId,
            contentType: contentType || original.contentType,
            ciphertext: ciphertext || null,
            editsMessageId: rootMessageId,
          })
          .returning();

        if (envelopes && envelopes.length > 0) {
          const deviceIds = envelopes.map((e) => e.recipientDeviceId);

          const devicesList = await tx.query.userDevices.findMany({
            where: inArray(userDevices.id, deviceIds),
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
            recipientDeviceIds = validEnvelopes.map((e) => e.recipientDeviceId);
          }
        }

        return insertedMessage;
      });
    } catch (error) {
      console.error('Transaction failed for message edit:', error);
      socket.emit('error', { event: 'edit_message', message: 'Failed to persist message edit' });
      return;
    }

    if (message) {
      socket.emit('message_ack', { messageId, sequenceNumber: message.sequenceNumber });
      io.to(conversationId).emit('new_message', message);
    }

    io.to(conversationId).emit('message_edited', {
      originalMessageId: rootMessageId,
      newMessageId: messageId,
    });

    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));

    void dispatchOfflinePush(conversationId, messageId, recipientDeviceIds);
  });

  // ── send_file_message ──────────────────────────────────────────────────────
  // Payload: { conversationId: string; fileId: string; content: string;
  //            contentType: 'file'|'image'|'video'|'audio' }
  //
  // `content` is the E2EE envelope ciphertext. It must contain the fields
  // { fileId, fileName, mimeType, size, fileKey, thumbnail? } client-side before
  // encryption. The server only validates that:
  //   1. The sender is a member of the conversation.
  //   2. The referenced file exists, is `ready`, and belongs to this conversation
  //      (uploader access-control — only the uploader may reference a file).
  //
  // `fileKey` must NEVER appear server-side in plaintext — it exists only inside
  // the encrypted `content` envelope.
  socket.on(
    'send_file_message',
    async (payload: {
      conversationId: string;
      fileId: string;
      content: string;
      contentType: 'file' | 'image' | 'video' | 'audio';
    }) => {
      const { conversationId, fileId, content, contentType } = payload;

      if (!content?.trim()) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'Content (envelope ciphertext) must not be empty',
        });
        return;
      }

      const validContentTypes = ['file', 'image', 'video', 'audio'] as const;
      if (!validContentTypes.includes(contentType)) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'contentType must be one of: file, image, video, audio',
        });
        return;
      }

      const membership = await db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      });

      if (!membership) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'Not a member of this conversation',
        });
        return;
      }

      // Validate file: must exist, be ready, belong to this conversation, and
      // have been uploaded by the sender (access-control).
      const file = await db.query.files.findFirst({
        where: eq(files.id, fileId),
      });

      if (!file) {
        socket.emit('error', { event: 'send_file_message', message: 'File not found' });
        return;
      }

      if (file.status !== 'ready') {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'File is not ready for use',
        });
        return;
      }

      if (file.conversationId !== conversationId) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'File does not belong to this conversation',
        });
        return;
      }

      if (file.uploaderId !== userId) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'Access denied: you are not the uploader of this file',
        });
        return;
      }

      let message;
      try {
        message = await db.transaction(async (tx) => {
          const [insertedMessage] = await tx
            .insert(messages)
            .values({
              conversationId,
              senderId: userId,
              ciphertext: content.trim(),
              contentType,
              fileId,
            })
            .returning();

          return insertedMessage;
        });
      } catch (error) {
        console.error('Transaction failed for file message:', error);
        socket.emit('error', { event: 'send_file_message', message: 'Failed to persist file message' });
        return;
      }

      if (message) {
        io.to(conversationId).emit('new_message', message);

      // Emit a file_message event for file-type content so recipients
      // know to fetch file bytes via GET /files/:id over HTTP.
      const ct = contentType || 'text/plain';
      if (
        ct.startsWith('file/') ||
        ct === 'file' ||
        ct.startsWith('image/') ||
        ct.startsWith('video/') ||
        ct.startsWith('audio/')
      ) {
        io.to(conversationId).emit('file_message', {
          messageId,
          conversationId,
          fileId: messageId,
        });
      }

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));

      // Dispatch push notifications to offline members who
      // haven't muted the conversation and have push enabled.
      sendPushForMessage({
        conversationId,
        messageId,
        senderId: userId,
      });
    },
  );

  // ── message_history ────────────────────────────────────────────────────────
  dispatcher.register('message_history', async (payload) => {
    const { conversationId, before } = payload as {
      conversationId: string;
      before?: string;
    };

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', {
        event: 'message_history',
        message: 'Not a member of this conversation',
      });
      return;
    }

    let cursor: Date | undefined;

    if (before) {
      const ref = await db.query.messages.findFirst({
        where: eq(messages.id, before),
      });
      cursor = ref?.createdAt;
    }

    const history = await db.query.messages.findMany({
      where: cursor
        ? and(eq(messages.conversationId, conversationId), lt(messages.createdAt, cursor))
        : eq(messages.conversationId, conversationId),
      orderBy: desc(messages.createdAt),
      limit: PAGE_SIZE,
      with: {
        envelopes: true,
        senderDevice: true,
        sender: { columns: { id: true, username: true, avatarUrl: true } },
      },
    });

    socket.emit('message_history', {
      conversationId,
      messages: history.reverse().map((message) => serializeMessage(message)),
    });
  });

  // ── delete_message ─────────────────────────────────────────────────────────
  dispatcher.register('delete_message', async (payload) => {
    const { messageId } = payload as { messageId: string };
    if (!messageId) return;

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
    });

    if (!message || message.senderId !== userId) {
      socket.emit('error', { event: 'delete_message', message: 'Message not found or not sender' });
      return;
    }

    await db
      .update(messages)
      .set({ deletedAt: new Date(), ciphertext: null })
      .where(eq(messages.id, messageId));

    await db.delete(messageEnvelopes).where(eq(messageEnvelopes.messageId, messageId));

    if (message.fileId) {
      const { softDeleteFile } = await import('../services/fileCleanup.js');
      await softDeleteFile(message.fileId);
    }

    io.to(message.conversationId).emit('message_deleted', { messageId });
  });

  // ── message_read ───────────────────────────────────────────────────────────
  dispatcher.register('message_read', async (payload) => {
    const { conversationId, lastReadMessageId } = payload as {
      conversationId: string;
      lastReadMessageId: string;
    };

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'message_read', message: 'Not a member of this conversation' });
      return;
    }

    const message = await db.query.messages.findFirst({
      where: and(eq(messages.id, lastReadMessageId), eq(messages.conversationId, conversationId)),
    });

    if (!message) {
      socket.emit('error', {
        event: 'message_read',
        message: 'Message not found in conversation',
      });
      return;
    }

    await db
      .update(conversationMembers)
      .set({ lastReadMessageId })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      );

    io.to(conversationId).volatile.emit('read_receipt', { conversationId, userId, lastReadMessageId });

    if (redis) {
      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });
      await publishEphemeral(
        redis,
        members.map((member) => member.userId),
        { type: 'read_receipt', data: { conversationId, userId, lastReadMessageId } },
      );
    }
  });

  // ── message_delivered ──────────────────────────────────────────────────────
  dispatcher.register('message_delivered', async (payload) => {
    const { conversationId, messageId, envelopeId, sequenceNumber } = payload as {
      conversationId?: string;
      messageId?: string;
      envelopeId?: string;
      sequenceNumber?: number;
    };

    if (!conversationId || !messageId) {
      socket.emit('error', {
        event: 'message_delivered',
        message: 'conversationId and messageId are required',
      });
      return;
    }

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'message_delivered', message: 'Not a member of this conversation' });
      return;
    }

    await db
      .update(messageEnvelopes)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          eq(messageEnvelopes.messageId, messageId),
          eq(messageEnvelopes.recipientDeviceId, socket.auth!.deviceId),
        ),
      );

    io.to(conversationId).volatile.emit('delivery_receipt', {
      conversationId,
      messageId,
      envelopeId,
      userId,
      deviceId: socket.auth!.deviceId,
      sequenceNumber,
      deliveredAt: new Date().toISOString(),
    });

    if (redis) {
      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });
      await publishEphemeral(
        redis,
        members.map((member) => member.userId),
        {
          type: 'delivery_receipt',
          data: { conversationId, messageId, envelopeId, userId, deviceId: socket.auth!.deviceId, sequenceNumber },
        },
      );
    }
  });

  // ── resume ─────────────────────────────────────────────────────────────────
  dispatcher.register('resume', async (payload) => {
    if (!redis) {
      socket.emit('resume_complete', { lastEventId: null, syncRequired: true });
      return;
    }

    const lastEventId =
      typeof (payload as { lastEventId?: string }).lastEventId === 'string'
        ? (payload as { lastEventId: string }).lastEventId
        : '';

    const missed = await readMissedEvents(redis, userId, lastEventId);

    for (const event of missed) {
      socket.emit('ephemeral_replay', {
        id: event.id,
        type: event.type,
        data: event.data,
      });
    }

    const newCursor = missed.length > 0 ? missed[missed.length - 1]!.id : lastEventId || null;
    socket.emit('resume_complete', { lastEventId: newCursor, syncRequired: true });
  });

  // ── create_conversation ────────────────────────────────────────────────────
  dispatcher.register('create_conversation', async (payload) => {
    const { type, name, memberIds } = payload as {
      type: 'dm' | 'group';
      name?: string;
      memberIds: string[];
    };

    const allMembers = Array.from(new Set([userId, ...memberIds]));

    const [conversation] = await db.insert(conversations).values({ type, name }).returning();

    if (!conversation) {
      socket.emit('error', {
        event: 'create_conversation',
        message: 'Failed to create conversation',
      });
      return;
    }

    await db
      .insert(conversationMembers)
      .values(allMembers.map((uid) => ({ conversationId: conversation.id, userId: uid })));

    socket.emit('conversation_created', conversation);

    await invalidateConversationCaches(allMembers);
  });

  // ── typing_start ───────────────────────────────────────────────────────────
  dispatcher.register('typing_start', async (payload) => {
    const { conversationId, deviceId: payloadDeviceId } = payload as {
      conversationId: string;
      deviceId?: string;
    };

    if (!conversationId?.trim()) {
      socket.emit('error', { event: 'typing_start', message: 'Invalid conversationId' });
      return;
    }

    if (!socket.rooms?.has(conversationId)) {
      const membership = await db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      });

      if (!membership) {
        socket.emit('error', {
          event: 'typing_start',
          message: 'Not a member of this conversation',
        });
        return;
      }
    }

    const relayPayload: { conversationId: string; userId: string; deviceId?: string } = {
      conversationId,
      userId,
    };

    if (payloadDeviceId?.trim()) {
      relayPayload.deviceId = payloadDeviceId.trim();
    }

    const timerKey = relayPayload.deviceId
      ? `${conversationId}:${relayPayload.deviceId}`
      : conversationId;

    const existing = typingTimers.get(timerKey);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      typingTimers.delete(timerKey);
      socket.to(conversationId).emit('typing_stop', relayPayload);
    }, 5000);

    typingTimers.set(timerKey, timer);
    socket.to(conversationId).emit('typing_start', relayPayload);
  });

  // ── typing_stop ────────────────────────────────────────────────────────────
  dispatcher.register('typing_stop', async (payload) => {
    const { conversationId, deviceId: payloadDeviceId } = payload as {
      conversationId: string;
      deviceId?: string;
    };

    if (!conversationId?.trim()) {
      socket.emit('error', { event: 'typing_stop', message: 'Invalid conversationId' });
      return;
    }

    if (!socket.rooms?.has(conversationId)) {
      const membership = await db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      });

      if (!membership) {
        socket.emit('error', {
          event: 'typing_stop',
          message: 'Not a member of this conversation',
        });
        return;
      }
    }

    const relayPayload: { conversationId: string; userId: string; deviceId?: string } = {
      conversationId,
      userId,
    };

    if (payloadDeviceId?.trim()) {
      relayPayload.deviceId = payloadDeviceId.trim();
    }

    const timerKey = relayPayload.deviceId
      ? `${conversationId}:${relayPayload.deviceId}`
      : conversationId;

    const existing = typingTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      typingTimers.delete(timerKey);
    }

    socket.to(conversationId).emit('typing_stop', relayPayload);
  });

  // ── ask_assistant ──────────────────────────────────────────────────────────
  const ASSISTANT_USER_ID = '00000000-0000-4000-8000-000000000000';

  dispatcher.register('ask_assistant', async (payload) => {
    const { conversationId, content } = payload as {
      conversationId: string;
      content: string;
    };

    if (!content?.trim().startsWith('@assistant')) {
      return;
    }

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', {
        event: 'ask_assistant',
        message: 'Not a member of this conversation',
      });
      return;
    }

    if (redis) {
      const rlKey = `rl:ask_assistant:${userId}`;
      const count = await redis.incr(rlKey);

      if (count === 1) {
        await redis.expire(rlKey, 60);
      }

      if (count > 5) {
        socket.emit('error', { event: 'rate_limited', message: 'Rate limit exceeded' });
        return;
      }
    }

    try {
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, conversation_id: conversationId }),
      });

      if (!response.ok) {
        throw new Error('AI agent error');
      }

      const data = (await response.json()) as { reply: string };

      await db.execute(sql`
        INSERT INTO users (id, username, avatar_url)
        VALUES (
          ${ASSISTANT_USER_ID},
          'Assistant',
          'https://ui-avatars.com/api/?name=AI&background=0D8ABC&color=fff'
        )
        ON CONFLICT (id) DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO conversation_members (conversation_id, user_id)
        VALUES (${conversationId}, ${ASSISTANT_USER_ID})
        ON CONFLICT DO NOTHING
      `);

      const [replyMessage] = await db
        .insert(messages)
        .values({
          conversationId,
          senderId: ASSISTANT_USER_ID,
          contentType: 'text/plain',
          ciphertext: data.reply,
        })
        .returning();

      io.to(conversationId).volatile.emit('new_message', replyMessage);

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));
    } catch (err) {
      console.error('ask_assistant error:', err);
      socket.emit('error', { event: 'ask_assistant', message: 'Failed to get AI reply' });
    }
  });

  // Activate the standard envelope dispatcher.
  dispatcher.listen();
}
