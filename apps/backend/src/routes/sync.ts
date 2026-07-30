import { Router, type Router as RouterType } from 'express';
import { and, asc, eq, gt, isNull, or, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messageEnvelopes, messages, devices } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';

export const syncRouter: RouterType = Router();

syncRouter.use(requireAuth);

// TTL for offline envelope retention (default 7 days, configurable via env).
const ENVELOPE_TTL_MS = parseInt(process.env['ENVELOPE_TTL_SECONDS'] ?? '604800', 10) * 1000;

const SYNC_PAGE_SIZE = parseInt(process.env['SYNC_PAGE_SIZE'] ?? '50', 10);

interface SyncCursor {
  createdAt: Date;
  id: string;
}

// Cursor is the envelope's own (createdAt, id) — not messages.sequenceNumber.
// A per-conversation sequence number (#128) can't serve as a coherent cursor
// across a device's *different* conversations, which is exactly what an
// offline-catchup sync needs (#137); the envelope's own creation instant,
// tie-broken by its id, is comparable across every conversation the device
// has envelopes in.
function encodeCursor(c: SyncCursor): string {
  return `${c.createdAt.getTime()}:${c.id}`;
}

function decodeCursor(raw: string): SyncCursor | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const millis = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(millis) || !id) return null;
  return { createdAt: new Date(millis), id };
}

// ─── GET /sync ────────────────────────────────────────────────────────────────
//
// Returns message envelopes addressed to a device that are newer than the
// provided cursor, ordered deterministically by (createdAt, id) across every
// conversation the device has envelopes in. Cursor-based, stable under
// concurrent inserts (id tie-breaks same-millisecond envelopes).
//
// Query params:
//   deviceId — UUID of the devices entry (E2E encryption device)
//   cursor   — opaque cursor from a previous response's `nextCursor`;
//              omit to fetch from the beginning of the retention window
//   limit    — page size (max SYNC_PAGE_SIZE)

syncRouter.get('/', async (req: AuthRequest, res) => {
  const { userId } = req.auth!;

  const {
    deviceId,
    cursor: cursorParam,
    limit: limitParam,
  } = req.query as {
    deviceId?: string;
    cursor?: string;
    limit?: string;
  };

  if (!deviceId) {
    res.status(400).json({ error: 'deviceId is required' });
    return;
  }

  let cursor: SyncCursor | undefined;
  if (cursorParam) {
    const decoded = decodeCursor(cursorParam);
    if (!decoded) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    cursor = decoded;
  }

  const pageSize = Math.min(
    parseInt(limitParam ?? String(SYNC_PAGE_SIZE), 10) || SYNC_PAGE_SIZE,
    SYNC_PAGE_SIZE,
  );

  // Verify the requesting user owns this E2E device.
  const ownedDevice = await db.query.devices.findFirst({
    where: and(eq(devices.id, deviceId), eq(devices.userId, userId)),
    columns: { id: true, revokedAt: true },
  });

  if (!ownedDevice) {
    res.status(403).json({ error: 'Device not found or not owned by this user' });
    return;
  }

  // TTL cutoff — envelopes older than this are considered expired.
  const ttlCutoff = new Date(Date.now() - ENVELOPE_TTL_MS);

  const rows = await db
    .select({
      id: messageEnvelopes.id,
      messageId: messageEnvelopes.messageId,
      ciphertext: messageEnvelopes.ciphertext,
      protocol: messageEnvelopes.protocol,
      deliveredAt: messageEnvelopes.deliveredAt,
      envelopeCreatedAt: messageEnvelopes.createdAt,
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
        cursor
          ? or(
              gt(messageEnvelopes.createdAt, cursor.createdAt),
              and(
                eq(messageEnvelopes.createdAt, cursor.createdAt),
                gt(messageEnvelopes.id, cursor.id),
              ),
            )
          : undefined,
        // Exclude TTL-expired envelopes (already delivered AND past retention).
        or(isNull(messageEnvelopes.deliveredAt), gt(messageEnvelopes.createdAt, ttlCutoff)),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messageEnvelopes.createdAt), asc(messageEnvelopes.id))
    .limit(pageSize + 1); // fetch one extra to detect hasMore

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  const lastRow = page[page.length - 1];
  const nextCursor = lastRow
    ? encodeCursor({ createdAt: lastRow.envelopeCreatedAt, id: lastRow.id })
    : (cursorParam ?? null);

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
      // #364 — which construction encrypted this envelope. Envelopes written
      // before the cutover stay `sealed_box` and decrypt on the Phase-1 path,
      // so catching up across the cutover loses nothing.
      protocol: r.protocol,
      deliveredAt: r.deliveredAt,
      createdAt: r.envelopeCreatedAt,
      messageCreatedAt: r.messageCreatedAt,
    })),
    nextCursor,
    hasMore,
  });
});
