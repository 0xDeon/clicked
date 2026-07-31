/**
 * User-device routes — public key lookup for inbound decryption (#122).
 *
 * GET /user-devices/:id/public-key
 * Returns the identity public key for a sender device when the caller shares
 * a conversation with the device owner.
 */

import { Router, type Router as RouterType } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, devices } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { normalizeCapabilities } from '../lib/capabilities.js';

export const userDevicesRouter: RouterType = Router();

userDevicesRouter.use(requireAuth);

userDevicesRouter.get('/:id/public-key', async (req: AuthRequest, res) => {
  const senderDeviceId = req.params['id'] as string;
  const requesterId = req.auth!.userId;

  try {
    const device = await db.query.devices.findFirst({
      where: and(eq(devices.id, senderDeviceId), isNull(devices.revokedAt)),
      columns: {
        id: true,
        userId: true,
        identityPublicKey: true,
        capabilities: true,
      },
    });

    if (!device) {
      res.status(404).json({ error: 'Device not found or revoked' });
      return;
    }

    // Caller must share at least one conversation with the device owner.
    const ownerConversations = db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, device.userId));

    const [coMember] = await db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, requesterId),
          inArray(conversationMembers.conversationId, ownerConversations),
        ),
      )
      .limit(1);

    if (!coMember) {
      res.status(403).json({ error: 'No shared conversation with device owner' });
      return;
    }

    res.json({
      id: device.id,
      userId: device.userId,
      identityPublicKey: device.identityPublicKey,
      capabilities: normalizeCapabilities(device.capabilities),
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch device public key' });
  }
});
