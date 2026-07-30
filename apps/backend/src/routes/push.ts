import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pushSubscriptions } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const pushRouter: IRouter = Router();
pushRouter.use(requireAuth);

/**
 * Issue #349 — single source of truth for the VAPID public key, so the
 * frontend never configures it independently of the backend's own
 * VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY pair (a drift between the two silently
 * breaks push delivery). `configured: false` lets the frontend skip push
 * registration gracefully when the backend has no VAPID keys set up.
 */
pushRouter.get('/vapid-public-key', (_req: AuthRequest, res) => {
  const vapidPublicKey = process.env['VAPID_PUBLIC_KEY'];

  if (!vapidPublicKey) {
    res.status(200).json({ configured: false, vapidPublicKey: null });
    return;
  }

  res.status(200).json({ configured: true, vapidPublicKey });
});

pushRouter.post('/subscriptions', async (req: AuthRequest, res) => {
  const deviceId = req.auth!.deviceId;
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    res.status(400).json({ error: 'Missing endpoint or keys' });
    return;
  }

  try {
    await db
      .insert(pushSubscriptions)
      .values({
        deviceId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.endpoint],
        set: {
          deviceId,
          p256dh: keys.p256dh,
          auth: keys.auth,
          disabledAt: null,
          lastUsedAt: new Date(),
        },
      });

    res.status(200).json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to register subscription' });
  }
});

pushRouter.delete('/subscriptions', async (req: AuthRequest, res) => {
  const deviceId = req.auth!.deviceId;
  const { endpoint } = req.body;

  if (!endpoint) {
    res.status(400).json({ error: 'Endpoint is required' });
    return;
  }

  try {
    await db
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.deviceId, deviceId)),
      );
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
});

/**
 * Touch lastUsedAt for active (non-disabled) subscriptions by device.
 * Called internally before sending a push notification.
 */
export async function touchSubscription(endpoint: string): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(pushSubscriptions.endpoint, endpoint), isNull(pushSubscriptions.disabledAt)));
}

/**
 * Mark a subscription as disabled (e.g. after a 410 Gone from the push service).
 */
export async function disableSubscription(endpoint: string): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ disabledAt: new Date() })
    .where(eq(pushSubscriptions.endpoint, endpoint));
}
