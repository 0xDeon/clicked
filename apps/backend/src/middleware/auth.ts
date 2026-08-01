import type { Request, Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
import { recordAuditEvent, requestContext } from '../services/auditLog.js';

export interface AuthRequest extends Request {
  auth?: JwtPayload;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = header.slice(7);

  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!payload.deviceId) {
    res.status(401).json({ error: 'Token missing deviceId' });
    return;
  }

  // Verify the (userId, deviceId) pair exists and is not revoked.
  const device = await db.query.devices.findFirst({
    where: and(eq(devices.id, payload.deviceId), eq(devices.userId, payload.userId)),
  });

  if (!device || device.revokedAt) {
    // Audited (#376): the token's signature was valid, so this is a real
    // credential being replayed after the device lost its authorisation —
    // unlike a malformed or expired token, which any scanner produces and
    // which would let an unauthenticated caller flood the audit table.
    void recordAuditEvent({
      action: 'auth_failed',
      subjectUserId: payload.userId,
      actorDeviceId: device ? payload.deviceId : null,
      targetType: 'device',
      targetId: payload.deviceId,
      ...requestContext(req),
      metadata: { reason: device ? 'device_revoked' : 'device_not_found' },
    });

    res.status(401).json({ error: 'Device not found or has been revoked' });
    return;
  }

  req.auth = payload;
  next();
}
