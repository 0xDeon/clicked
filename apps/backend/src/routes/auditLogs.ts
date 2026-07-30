/**
 * GET /audit-logs — a user's own security history (#376).
 *
 * Scoped to the caller: there is no parameter for whose log to read, so a
 * compromised token cannot be used to enumerate anyone else's security events.
 * Returns events where the caller was either the actor or the subject, newest
 * first, cursor-paginated.
 */
import { Router, type Router as RouterType } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { auditActionEnum, type AuditAction } from '../db/schema.js';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  MAX_AUDIT_PAGE_SIZE,
  queryAuditLog,
} from '../services/auditLog.js';

export const auditLogsRouter: RouterType = Router();

auditLogsRouter.use(requireAuth);

const VALID_ACTIONS = new Set<string>(auditActionEnum.enumValues);

auditLogsRouter.get('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const rawAction = typeof req.query['action'] === 'string' ? req.query['action'] : undefined;
  if (rawAction && !VALID_ACTIONS.has(rawAction)) {
    res.status(400).json({
      error: 'Unknown action filter',
      allowed: auditActionEnum.enumValues,
    });
    return;
  }

  const rawLimit = Number.parseInt(req.query['limit'] as string, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_AUDIT_PAGE_SIZE;

  const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;

  try {
    const { events, nextCursor, hasMore } = await queryAuditLog({
      userId,
      ...(rawAction ? { action: rawAction as AuditAction } : {}),
      ...(cursor ? { cursor } : {}),
      limit: Math.min(limit, MAX_AUDIT_PAGE_SIZE),
    });

    res.json({
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        actorUserId: event.actorUserId,
        actorDeviceId: event.actorDeviceId,
        subjectUserId: event.subjectUserId,
        targetType: event.targetType,
        targetId: event.targetId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: event.metadata,
        createdAt: event.createdAt,
        // Whether this was something the account did, or something done to it.
        direction: event.actorUserId === userId ? 'performed' : 'received',
      })),
      // Null once the end is reached, so a client pages until it is null.
      nextCursor,
      hasMore,
    });
  } catch {
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});
