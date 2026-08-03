import type { Server } from 'socket.io';
import { and, eq, lt, desc, sql, inArray, isNull, or, lte } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  conversations,
  conversationMembers,
  messages,
  messageEnvelopes,
  files,
  users,
} from '../db/schema.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';
import {
  buildBroadcastEnvelopes,
  findMissingSiblingDeviceIds,
  insertMessageEnvelopes,
} from '../lib/messageFanout.js';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';
import { checkEnvelopeSizes } from '../services/rateLimit.js';
import { dispatchOfflinePush, FILE_CONTENT_TYPES } from '../services/pushNotification.js';
import { deliverMessage } from '../services/deliveryPipeline.js';
import { publishEphemeral, readMissedEvents } from '../services/resumeStream.js';
import { handleDeviceDeliveryReceipt } from '../services/deliveryAggregation.js';
import { conversationRoom } from '../services/roomManager.js';
import { checkEnvelopeProtocols, type E2eeProtocol } from '../services/e2eeProtocol.js';
import { BASELINE_PROTOCOL } from '../lib/capabilities.js';
import { applyMlsVisibility } from '../lib/mlsVisibility.js';
import { getConversationEpochWindow } from '../services/mlsGroups.js';
import { handleHeartbeat } from '../services/heartbeat.js';
import { cleanupStaleSockets } from '../services/presence.js';
import { EventDispatcher } from './dispatcher.js';
import { findForbiddenSessionStateField } from '../lib/signalInvariants.js';
import { checkFirstContactLimit } from '../services/rateLimit.js';

const PAGE_SIZE = 30;

async function findUsersBlockingConversationAccess(
  type: 'dm' | 'group',
  memberIds: string[],
): Promise<string[]> {
  if (memberIds.length === 0) return [];

  const invitedUsers = await db.query.users.findMany({
    where: inArray(users.id, memberIds),
    columns: {
      id: true,
      allowDirectMessages: true,
      allowGroupInvites: true,
    },
  });

  return invitedUsers
    .filter((user) => (type === 'dm' ? !user.allowDirectMessages : !user.allowGroupInvites))
    .map((user) => user.id);
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
      socket.to(conversationRoom(cid)).emit('typing_stop', rp);
    }
    typingTimers.clear();
  });

  // ── heartbeat ──────────────────────────────────────────────────────────────
  dispatcher.register('heartbeat', async () => {
    const deviceId = socket.auth!.deviceId;
    await handleHeartbeat(socket, userId, deviceId, redis);
    if (redis) {
      await cleanupStaleSockets(io, redis, userId, socket.id);
    }
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
    // Signal invariant: the server never accepts session/ratchet/private-key
    // state, only opaque ciphertext and public routing metadata.
    const forbiddenField = findForbiddenSessionStateField(payload);
    if (forbiddenField) {
      socket.emit('error', {
        event: 'send_message',
        code: 400,
        message: `Field "${forbiddenField}" is not permitted: the server never stores session or private-key state`,
      });
      return;
    }

    const {
      conversationId,
      messageId,
      content,
      contentType,
      ciphertext,
      envelopes,
      fileId: inputFileId,
      mlsEpoch,
    } = payload as {
      conversationId: string;
      messageId?: string;
      content?: string;
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
    const resolvedContentType = contentType || 'text';

    const validation = validateMessagePayload({
      contentType: resolvedContentType,
      ciphertext: effectiveCiphertext,
      envelopes,
      fileId: inputFileId,
      mlsEpoch,
    });
    if (!validation.ok) {
      socket.emit('error', {
        event: 'send_message',
        code: validation.code,
        message: validation.message,
      });
      return;
    }

    const envelopeSizeCheck = checkEnvelopeSizes(envelopes);
    if (!envelopeSizeCheck.valid) {
      socket.emit('error', {
        event: 'send_message',
        code: 'envelope_too_large',
        message: `Envelope for device ${envelopeSizeCheck.oversizedDeviceId} exceeds size limit`,
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
      columns: { createdAt: true },
    });

    if (existing) {
      socket.emit('message_ack', { messageId, createdAt: existing.createdAt });
      return;
    }

    // Enforce full sibling-device coverage (#188). MLS group messages are
    // exempt (#372): a single group ciphertext already reaches every member
    // device in the tree, so there are no per-device envelopes to be missing.
    const missingSiblings =
      mlsEpoch === undefined ? await findMissingSiblingDeviceIds(userId, deviceId, envelopes) : [];
    if (missingSiblings.length > 0) {
      socket.emit('error', {
        event: 'device_set_mismatch',
        message: `Missing envelopes for ${missingSiblings.length} sibling device(s)`,
        missingDeviceIds: missingSiblings,
      });
      return;
    }

    // Enforce the negotiated E2EE protocol (#364) — same rule as POST /messages.
    if (envelopes && envelopes.length > 0) {
      const protocolCheck = await checkEnvelopeProtocols(
        deviceId,
        envelopes.map((e) => ({
          recipientDeviceId: e.recipientDeviceId,
          protocol: e.protocol ?? BASELINE_PROTOCOL,
        })),
      );

      if (!protocolCheck.ok) {
        socket.emit('error', {
          event: 'protocol_mismatch',
          code: protocolCheck.code,
          message: protocolCheck.error,
          violations: protocolCheck.violations,
        });
        return;
      }
    }

    let fileId: string | null = inputFileId || null;
    if (FILE_CONTENT_TYPES.has(resolvedContentType) && !fileId) {
      const [fileRow] = await db
        .insert(files)
        .values({
          storageKey: messageId,
          uploaderId: userId,
          conversationId,
          size: 0,
          mimeType: resolvedContentType,
          sha256: 'auto-generated',
        })
        .onConflictDoUpdate({ target: files.storageKey, set: { storageKey: messageId } })
        .returning({ id: files.id });
      fileId = fileRow?.id ?? null;
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
            contentType: resolvedContentType,
            ciphertext: effectiveCiphertext || null,
            fileId: fileId,
            mlsEpoch: mlsEpoch ?? null,
          })
          .returning();

        recipientDeviceIds = await insertMessageEnvelopes(tx, messageId, envelopes);

        return insertedMessage!;
      });
    } catch (error) {
      console.error('Transaction failed for message insert:', error);
      socket.emit('error', { event: 'send_message', message: 'Failed to persist message' });
      return;
    }

    if (message) {
      socket.emit('message_ack', { messageId, createdAt: message.createdAt });
      await deliverMessage(io, message, conversationId);

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });
      await invalidateConversationCaches(members.map((m) => m.userId));
      void dispatchOfflinePush(conversationId, messageId, recipientDeviceIds, userId);
    }
  });

  // ── edit_message ───────────────────────────────────────────────────────────
  dispatcher.register('edit_message', async (payload) => {
    // Signal invariant: the server never accepts session/ratchet/private-key
    // state, only opaque ciphertext and public routing metadata.
    const forbiddenField = findForbiddenSessionStateField(payload);
    if (forbiddenField) {
      socket.emit('error', {
        event: 'edit_message',
        code: 400,
        message: `Field "${forbiddenField}" is not permitted: the server never stores session or private-key state`,
      });
      return;
    }

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

    if (!ciphertext?.trim()) {
      socket.emit('error', {
        event: 'edit_message',
        message: 'Content (envelope ciphertext) must not be empty',
      });
      return;
    }

    const envelopeSizeCheck = checkEnvelopeSizes(envelopes);
    if (!envelopeSizeCheck.valid) {
      socket.emit('error', {
        event: 'edit_message',
        code: 'envelope_too_large',
        message: `Envelope for device ${envelopeSizeCheck.oversizedDeviceId} exceeds size limit`,
      });
      return;
    }

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

    const existing = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { createdAt: true },
    });

    if (existing) {
      socket.emit('message_ack', { messageId, createdAt: existing.createdAt });
      return;
    }

    // Enforce full sibling-device coverage (#188).
    const missingSiblings = await findMissingSiblingDeviceIds(userId, deviceId, envelopes);
    if (missingSiblings.length > 0) {
      socket.emit('error', {
        event: 'device_set_mismatch',
        message: `Missing envelopes for ${missingSiblings.length} sibling device(s)`,
        missingDeviceIds: missingSiblings,
      });
      return;
    }

    const rootMessageId = original.editsMessageId ?? original.id;
    const conversationId = original.conversationId;

    let message;
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

        await insertMessageEnvelopes(tx, messageId, envelopes);

        return insertedMessage!;
      });
    } catch (error) {
      console.error('Transaction failed for message edit:', error);
      socket.emit('error', { event: 'edit_message', message: 'Failed to persist message edit' });
      return;
    }

    if (message) {
      socket.emit('message_ack', { messageId, createdAt: message.createdAt });
      await deliverMessage(io, message, conversationId);

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });
      await invalidateConversationCaches(members.map((m) => m.userId));

      io.to(conversationRoom(conversationId)).emit('message_edited', {
        originalMessageId: rootMessageId,
        newMessageId: messageId,
      });
    }
  });

  // ── send_file_message ──────────────────────────────────────────────────────
  // Issue #347: routes through the same deliverMessage pipeline send_message
  // uses, so file messages get identical per-device receipts, resume/sync
  // backfill, and fan-out validation. `content` is the message-body envelope
  // ciphertext (as before); `envelopes` carries the file's symmetric
  // encryption key, individually sealed per recipient device — the key is
  // never accepted or stored as a server-visible plaintext field, only
  // inside each envelope's opaque ciphertext.
  socket.on(
    'send_file_message',
    async (payload: {
      conversationId: string;
      messageId?: string;
      fileId: string;
      content: string;
      ciphertext?: string;
      contentType: 'file' | 'image' | 'video' | 'audio';
    }) => {
      const { conversationId, messageId, fileId, content, contentType } = payload;

      if (!messageId) {
        socket.emit('error', {
          event: 'send_file_message',
          message: 'messageId is required',
        });
        return;
      }

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

      const existing = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
        columns: { createdAt: true },
      });

      if (existing) {
        socket.emit('message_ack', { messageId, createdAt: existing.createdAt });
        return;
      }

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
              id: messageId,
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
        socket.emit('error', {
          event: 'send_file_message',
          message: 'Failed to persist file message',
        });
        return;
      }

      if (message) {
        socket.emit('message_ack', { messageId, createdAt: message.createdAt });
        io.to(conversationId).emit('new_message', message);

        const members = await db.query.conversationMembers.findMany({
          where: eq(conversationMembers.conversationId, conversationId),
          columns: { userId: true },
        });
        await invalidateConversationCaches(members.map((member) => member.userId));

        sendPushForMessage({
          conversationId,
          messageId: message.id,
          senderId: userId,
        });
      }
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

    let cursor: { createdAt: Date; id: string } | undefined;

    if (before) {
      const ref = await db.query.messages.findFirst({
        where: eq(messages.id, before),
        columns: { createdAt: true, id: true },
      });
      cursor = ref ?? undefined;
    }

    const history = await db.query.messages.findMany({
      where: cursor
        ? and(
            eq(messages.conversationId, conversationId),
            or(
              lt(messages.createdAt, cursor.createdAt),
              and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
            ),
          )
        : eq(messages.conversationId, conversationId),
      orderBy: [desc(messages.createdAt), desc(messages.id)],
      limit: PAGE_SIZE,
      with: {
        envelopes: true,
        senderDevice: true,
        sender: { columns: { id: true, username: true, avatarUrl: true } },
      },
    });

    // #372 — same MLS epoch visibility rule as GET /conversations/:id/messages:
    // messages outside this device's membership window come back as
    // placeholders instead of undecryptable ciphertext.
    const { hasGroup, window } = await getConversationEpochWindow(
      conversationId,
      socket.auth!.deviceId,
    );

    socket.emit('message_history', {
      conversationId,
      messages: history
        .reverse()
        .map((message) =>
          serializeMessage(hasGroup ? applyMlsVisibility(message, window) : message),
        ),
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
    io.to(conversationRoom(message.conversationId)).emit('message_deleted', { messageId });
  });

  // ── message_read ───────────────────────────────────────────────────────────
  dispatcher.register('message_read', async (payload) => {
    const { conversationId, lastReadMessageId } = payload as {
      conversationId: string;
      lastReadMessageId: string;
    };
    const deviceId = socket.auth!.deviceId;

    const [user, membership] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { sendReadReceipts: true },
      }),
      db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      }),
    ]);

    if (!membership) {
      socket.emit('error', { event: 'message_read', message: 'Not a member of this conversation' });
      return;
    }

    const newMessage = await db.query.messages.findFirst({
      where: and(eq(messages.id, lastReadMessageId), eq(messages.conversationId, conversationId)),
    });

    if (!newMessage) {
      socket.emit('error', {
        event: 'message_read',
        message: 'Message not found in conversation',
      });
      return;
    }

    // Monotonicity check: only advance lastReadMessageId
    if (membership.lastReadMessageId) {
      const lastReadMessage = await db.query.messages.findFirst({
        where: eq(messages.id, membership.lastReadMessageId),
        columns: { createdAt: true },
      });

      if (lastReadMessage && newMessage.createdAt <= lastReadMessage.createdAt) {
        return; // Stale or backwards update, ignore
      }
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

    // Stamp readAt on all envelopes for this device up to the read point
    const messagesToUpdate = await db.query.messages.findMany({
      where: and(
        eq(messages.conversationId, conversationId),
        lte(messages.createdAt, newMessage.createdAt),
      ),
      columns: { id: true },
    });

    if (messagesToUpdate.length > 0) {
      const messageIds = messagesToUpdate.map((m) => m.id);
      await db
        .update(messageEnvelopes)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(messageEnvelopes.recipientDeviceId, deviceId),
            inArray(messageEnvelopes.messageId, messageIds),
            isNull(messageEnvelopes.readAt),
          ),
        );
    }

    // Privacy check: only broadcast if user has read receipts enabled
    if (!user?.sendReadReceipts) {
      return;
    }

    const receipt = {
      conversationId,
      userId,
      lastReadMessageId,
    };

    io.to(conversationId).volatile.emit('read_receipt', receipt);

    if (redis) {
      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });
      await publishEphemeral(
        redis,
        members.map((member) => member.userId),
        { type: 'read_receipt', data: receipt },
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
      socket.emit('error', {
        event: 'message_delivered',
        message: 'Not a member of this conversation',
      });
      return;
    }

    // Use the new aggregation service for per-device delivery tracking
    await handleDeviceDeliveryReceipt(
      io,
      redis,
      messageId,
      socket.auth!.deviceId,
      userId,
      conversationId,
    );

    // Also emit to conversation room for backward compatibility
    io.to(conversationId).volatile.emit('delivery_receipt', {
      conversationId,
      messageId,
      envelopeId,
      userId,
      deviceId: socket.auth!.deviceId,
      sequenceNumber,
      deliveredAt: new Date().toISOString(),
    });

    // Emit to conversation room for optimized fan-out
    io.to(conversationRoom(conversationId)).volatile.emit('device_delivery_receipt', {
      conversationId,
      messageId,
      envelopeId,
      recipientUserId: userId,
      recipientDeviceId: socket.auth!.deviceId,
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
          data: {
            conversationId,
            messageId,
            envelopeId,
            userId,
            deviceId: socket.auth!.deviceId,
            sequenceNumber,
          },
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

    const requestedMembers = Array.from(
      new Set(memberIds.filter((memberId) => memberId !== userId)),
    );
    const blockedMemberIds = await findUsersBlockingConversationAccess(type, requestedMembers);

    if (blockedMemberIds.length > 0) {
      socket.emit('error', {
        event: 'create_conversation',
        message:
          type === 'dm'
            ? 'One or more recipients are not accepting direct messages'
            : 'One or more recipients are not accepting group invites',
        blockedUserIds: blockedMemberIds,
      });
      return;
    }

    const allMembers = Array.from(new Set([userId, ...requestedMembers]));

    // #378: throttle first-contact DM spam (e.g. mass unsolicited DMs)
    if (type === 'dm') {
      const dmCheck = await checkFirstContactLimit(redis, userId);
      if (!dmCheck.allowed) {
        socket.emit('error', {
          event: 'create_conversation',
          message: 'Too many new conversations. Please wait before starting another.',
        });
        return;
      }
    }

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
      socket.to(conversationRoom(conversationId)).emit('typing_stop', relayPayload);
    }, 5000);

    typingTimers.set(timerKey, timer);
    socket.to(conversationId).emit('typing_start', relayPayload);
    socket.to(conversationRoom(conversationId)).emit('typing_start', relayPayload);
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
    socket.to(conversationRoom(conversationId)).emit('typing_stop', relayPayload);
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

    // Budget lives in config/rateLimits.ts with every other limit (#375).
    // Charged per user rather than per device: the cost being protected is the
    // downstream AI call, which one account can run up from any device.
    const assistantLimit = await consumeRateLimit('socket_ask_assistant', `user:${userId}`);
    if (!assistantLimit.allowed) {
      socket.emit('error', {
        event: 'rate_limited',
        message: 'Rate limit exceeded',
        limitedEvent: 'ask_assistant',
        limit: assistantLimit.limit,
        retryAfterSeconds: assistantLimit.resetSeconds,
      });
      return;
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

      // Membership is resolved before the insert so the reply can be fanned
      // out to every active device of every member (and reused afterwards for
      // cache invalidation).
      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      // A server-authored reply has no per-recipient key material, so every
      // device's envelope necessarily carries the same content — same as the
      // shared column did before. What changes is the fan-out *shape*: the
      // reply now flows through message_envelopes like every other message.
      // The sender's own devices are included: the assistant reply must reach
      // all of them, not just the device that asked.
      const replyEnvelopes = await buildBroadcastEnvelopes(
        members.map((member) => member.userId),
        data.reply,
      );

      const replyMessage = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(messages)
          .values({
            conversationId,
            senderId: ASSISTANT_USER_ID,
            contentType: 'text',
            ciphertext: data.reply,
          })
          .returning();

        await insertMessageEnvelopes(tx, inserted!.id, replyEnvelopes);

        return inserted;
      });

      if (replyMessage) {
        await deliverMessage(io, replyMessage, conversationId);
      }

      await invalidateConversationCaches(members.map((member) => member.userId));
    } catch (err) {
      console.error('ask_assistant error:', err);
      socket.emit('error', { event: 'ask_assistant', message: 'Failed to get AI reply' });
    }
  });

  // Activate the standard envelope dispatcher.
  dispatcher.listen();
}
