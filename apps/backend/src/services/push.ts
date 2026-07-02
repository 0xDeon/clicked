import webpush from 'web-push';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, pushSubscriptions, userDevices } from '../db/schema.js';
import { redis } from '../lib/redis.js';
import { isOnline } from './presence.js';

const VAPID_SUBJECT = process.env['VAPID_SUBJECT'] || 'mailto:admin@clicked.app';

if (process.env['VAPID_PUBLIC_KEY'] && process.env['VAPID_PRIVATE_KEY']) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    process.env['VAPID_PUBLIC_KEY'],
    process.env['VAPID_PRIVATE_KEY'],
  );
}

export interface PushContext {
  conversationId: string;
  messageId: string;
  senderId: string;
}

export async function sendPushForMessage(ctx: PushContext): Promise<void> {
  if (!process.env['VAPID_PUBLIC_KEY'] || !process.env['VAPID_PRIVATE_KEY']) {
    return;
  }

  try {
    const allMembers = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, ctx.conversationId),
      columns: { userId: true, isMuted: true },
    });

    for (const member of allMembers) {
      if (member.userId === ctx.senderId) continue;
      if (member.isMuted) continue;

      // Skip online users (active WS connection).
      if (redis) {
        const online = await isOnline(redis, member.userId);
        if (online) continue;
      }

      // Get non-revoked devices with push enabled.
      const devices = await db.query.userDevices.findMany({
        where: and(
          eq(userDevices.userId, member.userId),
          eq(userDevices.pushEnabled, true),
          isNull(userDevices.revokedAt),
        ),
        columns: { id: true },
      });

      for (const device of devices) {
        const sub = await db.query.pushSubscriptions.findFirst({
          where: eq(pushSubscriptions.deviceId, device.id),
          columns: { endpoint: true, p256dh: true, auth: true },
        });

        if (!sub) continue;

        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            JSON.stringify({
              type: 'new_message',
              conversationId: ctx.conversationId,
              messageId: ctx.messageId,
            }),
          );
        } catch {
          // Push delivery failures are non-critical.
        }
      }
    }
  } catch {
    // Push is best-effort; never let it break message delivery.
  }
}
