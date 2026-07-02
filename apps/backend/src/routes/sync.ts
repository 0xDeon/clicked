import { Router, type Router as RouterType } from 'express';
import { and, eq, gt, isNull, or, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messageEnvelopes, messages, userDevices } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';

export const syncRouter: RouterType = Router();

syncRouter.use(requireAuth);

// TTL for offline envelope retention (default 7 days, configurable via env).
const ENVELOPE_TTL_MS = parseInt(process.env['ENVELOPE_TTL_SECONDS'] ?? '604800', 10) * 1000;

const SYNC_PAGE_SIZE = parseInt(process.env['SYNC_PAGE_SIZE'] ?? '50', 10);

// ─── GET /sync ────────────────────────────────────────────────────────────────
//
// Returns message envelopes addressed to a device that are newer than the
// provided sinceSequence cursor, ordered deterministically by sequenceNumber.
// Supports cursor-based pagination stable under concurrent inserts.
//
// Query params:
//   deviceId      — UUID of the userDevices entry (E2E encryption device)
//   sinceSequence — integer cursor; only envelopes with sequenceNumber > this
//                   value are returned. Defaults to 0 (return everything).
//   limit         — page size (max SYNC_PAGE_SIZE)

syncRouter.get('/', async (req: AuthRequest, res) => {
  const { userId } = req.auth!;

  const {
    deviceId,
    sinceSequence,
    limit: limitParam,
  } = req.query as {
    deviceId?: string;
    sinceSequence?: string;
    limit?: string;
  };

  if (!deviceId) {
    res.status(400).json({ error: 'deviceId is required' });
    return;
  }

  const cursor = parseInt(sinceSequence ?? '0', 10);
  if (isNaN(cursor) || cursor < 0) {
    res.status(400).json({ error: 'sinceSequence must be a non-negative integer' });
    return;
  }

  const pageSize = Math.min(
    parseInt(limitParam ?? String(SYNC_PAGE_SIZE), 10) || SYNC_PAGE_SIZE,
    SYNC_PAGE_SIZE,
  );

  // Verify the requesting user owns this E2E device.
  const userDevice = await db.query.userDevices.findFirst({
    where: and(eq(userDevices.id, deviceId), eq(userDevices.userId, userId)),
    columns: { id: true, revokedAt: true },
  });

  if (!userDevice) {
    res.status(403).json({ error: 'Device not found or not owned by this user' });
    return;
  }

  // TTL cutoff — envelopes older than this are considered expired.
  const ttlCutoff = new Date(Date.now() - ENVELOPE_TTL_MS);

  // Join messageEnvelopes → messages to get sequenceNumber for cursor-based
  // pagination. Only return envelopes within TTL that haven't been delivered,
  // OR that the client explicitly requests again via cursor.
  const rows = await db
    .select({
      id: messageEnvelopes.id,
      messageId: messageEnvelopes.messageId,
      ciphertext: messageEnvelopes.ciphertext,
      deliveredAt: messageEnvelopes.deliveredAt,
      createdAt: messageEnvelopes.createdAt,
      sequenceNumber: messages.sequenceNumber,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      senderDeviceId: messages.senderDeviceId,
      contentType: messages.contentType,
      messageCreatedAt: messages.createdAt,
    })
    .from(messageEnvelopes)
    .innerJoin(messages, eq(messageEnvelopes.messageId, messages.id))
    .where(
      and(
        eq(messageEnvelopes.recipientDeviceId, deviceId),
        gt(messages.sequenceNumber, cursor),
        // Exclude TTL-expired envelopes (already delivered AND past retention).
        or(isNull(messageEnvelopes.deliveredAt), gt(messageEnvelopes.createdAt, ttlCutoff)),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(messages.sequenceNumber)
    .limit(pageSize + 1); // fetch one extra to detect hasMore

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  const nextCursor = page.length > 0 ? page[page.length - 1]!.sequenceNumber : cursor;

  // Mark returned envelopes as delivered (best-effort — do not block response).
  if (page.length > 0) {
    const ids = page.filter((r) => r.deliveredAt === null).map((r) => r.id);
    if (ids.length > 0) {
      db.update(messageEnvelopes)
        .set({ deliveredAt: new Date() })
        .where(inArray(messageEnvelopes.id, ids))
        .catch(() => {});
    }
  }

  res.json({
    envelopes: page.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      conversationId: r.conversationId,
      senderId: r.senderId,
      senderDeviceId: r.senderDeviceId,
      contentType: r.contentType,
      ciphertext: r.ciphertext,
      sequenceNumber: r.sequenceNumber,
      senderId: r.senderId,
      senderDeviceId: r.senderDeviceId,
      contentType: r.contentType,
      deliveredAt: r.deliveredAt,
      createdAt: r.createdAt,
      messageCreatedAt: r.messageCreatedAt,
    })),
    nextCursor,
    hasMore,
  });
});
