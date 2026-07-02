/**
 * Push notification delivery service.
 *
 * Implements:
 *   #236 – dispatch content-free Web Push when recipient device is offline
 *   #237 – prune dead subscriptions (410/404), back off on transient failures
 *   #239 – coalesce burst messages into a single push, rate-limit per device
 */
import webpush from 'web-push';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pushSubscriptions } from '../db/schema.js';
import { isDeviceConnected } from './deviceRevocation.js';

const FILE_CONTENT_TYPES = new Set(['file', 'image', 'video', 'audio']);

// ── VAPID initialisation ──────────────────────────────────────────────────────

const VAPID_SUBJECT = process.env['VAPID_SUBJECT'] ?? 'mailto:admin@clicked.app';
const VAPID_PUBLIC_KEY = process.env['VAPID_PUBLIC_KEY'];
const VAPID_PRIVATE_KEY = process.env['VAPID_PRIVATE_KEY'];

let vapidReady = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidReady = true;
}

// ── #239 Coalescing state ─────────────────────────────────────────────────────

const COALESCE_WINDOW_MS = 2_000;
const RATE_LIMIT_WINDOW_MS = 30_000;

interface CoalesceEntry {
  count: number;
  latestMessageId: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCoalesce = new Map<string, CoalesceEntry>();
const lastPushSentAt = new Map<string, number>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * #236 – After a message is persisted, dispatch push to every recipient device
 * that currently has no active socket connection.
 */
export async function dispatchOfflinePush(
  conversationId: string,
  messageId: string,
  recipientDeviceIds: string[],
): Promise<void> {
  if (!vapidReady || recipientDeviceIds.length === 0) return;

  for (const deviceId of recipientDeviceIds) {
    if (!isDeviceConnected(deviceId)) {
      queueCoalescedPush(deviceId, conversationId, messageId);
    }
  }
}

export { FILE_CONTENT_TYPES };

// ── #239 Coalescing ───────────────────────────────────────────────────────────

function queueCoalescedPush(deviceId: string, conversationId: string, messageId: string): void {
  const key = `${deviceId}:${conversationId}`;
  const existing = pendingCoalesce.get(key);

  if (existing) {
    existing.count += 1;
    existing.latestMessageId = messageId;
    return;
  }

  const entry: CoalesceEntry = {
    count: 1,
    latestMessageId: messageId,
    timer: setTimeout(async () => {
      pendingCoalesce.delete(key);
      await flushPush(deviceId, conversationId, entry.count, entry.latestMessageId);
    }, COALESCE_WINDOW_MS),
  };

  pendingCoalesce.set(key, entry);
}

async function flushPush(
  deviceId: string,
  conversationId: string,
  count: number,
  messageId: string,
): Promise<void> {
  // #239 – per-device rate limiting
  const now = Date.now();
  const lastSent = lastPushSentAt.get(deviceId) ?? 0;
  if (now - lastSent < RATE_LIMIT_WINDOW_MS) return;
  lastPushSentAt.set(deviceId, now);

  const subs = await db.query.pushSubscriptions.findMany({
    where: and(eq(pushSubscriptions.deviceId, deviceId), isNull(pushSubscriptions.disabledAt)),
  });

  const payload = JSON.stringify({ type: 'new_message', conversationId, messageId, count });

  await Promise.allSettled(subs.map((sub) => sendWebPush(sub, payload)));
}

// ── #237 Core send with hygiene ───────────────────────────────────────────────

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendWebPush(sub: SubRow, payload: string): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
    );

    await db
      .update(pushSubscriptions)
      .set({ lastUsedAt: new Date() })
      .where(eq(pushSubscriptions.id, sub.id));

    console.log(`[push] ok  → ${sub.endpoint.slice(0, 50)}`);
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;

    if (status === 410 || status === 404) {
      // Dead subscription – prune immediately (#237)
      console.log(`[push] prune ${status} → ${sub.endpoint.slice(0, 50)}`);
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    } else {
      // Transient failure – back off by disabling for 5 min (#237)
      const retryAfter = new Date(Date.now() + 5 * 60 * 1_000);
      console.warn(`[push] backoff (${status ?? 'err'}) → ${sub.endpoint.slice(0, 50)}`);
      await db
        .update(pushSubscriptions)
        .set({ disabledAt: retryAfter })
        .where(eq(pushSubscriptions.id, sub.id));
    }
  }
}

/**
 * Re-enable subscriptions whose backoff window has expired.
 * Called periodically by the cleanup job.
 */
export async function reenableExpiredBackoffs(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`UPDATE push_subscriptions SET disabled_at = NULL WHERE disabled_at IS NOT NULL AND disabled_at <= NOW()`,
  );
}
