import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, devices } from '../db/schema.js';
import { redis } from '../lib/redis.js';
import { isOnline } from './presence.js';
import { queueCoalescedPush } from './pushNotification.js';

export interface PushContext {
  conversationId: string;
  messageId: string;
  senderId: string;
}

/**
 * Push dispatch for file/image/video/audio messages (send_file_message).
 *
 * Shares queueCoalescedPush with the text-message path (#176) so a burst of
 * file messages coalesces into one push per device instead of one per
 * message, and gets the same per-device rate limit and dead-subscription
 * pruning/backoff hygiene (services/pushNotification.ts) — previously this
 * sent one uncoalesced webpush.sendNotification per file message and
 * silently swallowed all failures, never cleaning up dead subscriptions.
 *
 * The recipient-resolution logic here (mute check, per-device pushEnabled,
 * cross-node online check via Redis) stays local to this call site since
 * send_file_message doesn't build a per-device envelope/recipient list the
 * way send_message does — there's no recipientDeviceIds to reuse.
 */
export async function sendPushForMessage(ctx: PushContext): Promise<void> {
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
      const memberDevices = await db.query.devices.findMany({
        where: and(
          eq(devices.userId, member.userId),
          eq(devices.pushEnabled, true),
          isNull(devices.revokedAt),
        ),
        columns: { id: true },
      });

      for (const device of memberDevices) {
        queueCoalescedPush(device.id, ctx.conversationId, ctx.messageId);
      }
    }
  } catch {
    // Push is best-effort; never let it break message delivery.
  }
}
