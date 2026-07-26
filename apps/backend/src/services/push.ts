import { queueCoalescedPush } from './pushNotification.js';
import { getEligiblePushRecipients } from './pushFilter.js';
import { redis } from '../lib/redis.js';

export interface PushContext {
  conversationId: string;
  messageId: string;
  senderId: string;
}

/**
 * Push dispatch for file/image/video/audio messages (send_file_message).
 *
 * SECURITY FIX: Now uses shared filtering logic (pushFilter.ts) to ensure
 * consistent behavior with dispatchOfflinePush:
 * - Respects conversationMembers.isMuted
 * - Respects devices.pushEnabled
 * - Filters by connection state
 * - Filters by online/offline state
 *
 * Shares queueCoalescedPush with the text-message path (#176) so a burst of
 * file messages coalesces into one push per device instead of one per
 * message, and gets the same per-device rate limit and dead-subscription
 * pruning/backoff hygiene (services/pushNotification.ts).
 */
export async function sendPushForMessage(ctx: PushContext): Promise<void> {
  try {
    // Use shared filtering logic to get eligible recipients
    const eligibleDeviceIds = await getEligiblePushRecipients({
      conversationId: ctx.conversationId,
      senderId: ctx.senderId,
      redis,
    });

    for (const deviceId of eligibleDeviceIds) {
      queueCoalescedPush(deviceId, ctx.conversationId, ctx.messageId);
    }
  } catch {
    // Push is best-effort; never let it break message delivery.
  }
}
