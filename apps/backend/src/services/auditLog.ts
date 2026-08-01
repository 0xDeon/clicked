/**
 * Security audit log (#376).
 *
 * Records who did what, to whom, and when — for device linking and revocation,
 * "log out everywhere", key-bundle drains, failed authentication, denied file
 * access and group membership changes. The audience is an incident responder
 * reconstructing a compromise after the fact.
 *
 * Two rules shape everything here:
 *
 *   1. **No message content, ever.** An audit trail that leaks plaintext would
 *      undo the end-to-end encryption it exists to protect. `sanitizeMetadata`
 *      drops content-shaped keys and bounds everything else, so a careless
 *      caller cannot widen the blast radius by spreading a request body into
 *      the metadata.
 *   2. **Recording must never break the action.** A failed audit write is
 *      logged to stderr and swallowed. Failing a device revocation because the
 *      audit table is unavailable would make the security control less
 *      reliable than the thing it observes.
 *
 * Append-only is enforced by a database trigger (see the migration), not by
 * convention: the log is only worth having if the application account an
 * attacker reaches cannot rewrite it.
 */
import type { Request } from 'express';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLogs, type AuditAction, type AuditLog } from '../db/schema.js';
import type { AuthRequest } from '../middleware/auth.js';

/**
 * Keys never written to the log, matched case-insensitively as substrings.
 * A denylist rather than an allowlist because callers legitimately attach
 * varied identifiers and counts; the caps below bound whatever survives.
 */
const FORBIDDEN_KEY_PATTERNS = [
  'ciphertext',
  'plaintext',
  'content',
  'message',
  'body',
  'text',
  'envelope',
  'payload',
  'token',
  'secret',
  'password',
  'signature',
  'privatekey',
  'prekey',
];

/** Bounds on what a single row may carry. */
const MAX_METADATA_KEYS = 20;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_LENGTH = 20;
const MAX_USER_AGENT_LENGTH = 256;

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }

  if (Array.isArray(value)) {
    if (depth <= 0) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, depth - 1));
  }

  if (typeof value === 'object') {
    // Nested objects are where a whole request body sneaks in, so they are
    // summarised rather than recursed past one level.
    if (depth <= 0) return '[object]';
    return sanitizeRecord(value as Record<string, unknown>, depth - 1);
  }

  // Functions, symbols, undefined: nothing an incident responder can use.
  return undefined;
}

function sanitizeRecord(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_METADATA_KEYS) break;
    if (isForbiddenKey(key)) {
      output[key] = '[redacted]';
      continue;
    }

    const sanitized = sanitizeValue(value, depth);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }

  return output;
}

/**
 * Strip content-shaped keys and bound size. Exported so the guarantee is
 * directly testable rather than only observable through a database write.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const sanitized = sanitizeRecord(metadata, 1);
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export interface AuditEvent {
  action: AuditAction;
  /** Who performed the action, when known. */
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  /** Whose account the event concerns. Defaults to the actor. */
  subjectUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Client address and user agent, for the "was this me?" question. */
export function requestContext(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const userAgent = req.get('user-agent');
  return {
    ipAddress: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}

/** Actor identity plus request context, for a route behind `requireAuth`. */
export function actorFromRequest(
  req: AuthRequest,
): Pick<AuditEvent, 'actorUserId' | 'actorDeviceId' | 'ipAddress' | 'userAgent'> {
  return {
    actorUserId: req.auth?.userId ?? null,
    actorDeviceId: req.auth?.deviceId ?? null,
    ...requestContext(req),
  };
}

/**
 * Append one event. Never throws and never rejects — callers may `void` this
 * without risking an unhandled rejection taking down the process.
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      action: event.action,
      actorUserId: event.actorUserId ?? null,
      actorDeviceId: event.actorDeviceId ?? null,
      subjectUserId: event.subjectUserId ?? event.actorUserId ?? null,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
      metadata: sanitizeMetadata(event.metadata),
    });
  } catch (err) {
    // Deliberately swallowed — see the module comment.
    console.error('[audit] failed to record event', event.action, err);
  }
}

export interface AuditQuery {
  /** Account whose history is being read. */
  userId: string;
  action?: AuditAction;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 200;

export function encodeAuditCursor(row: Pick<AuditLog, 'createdAt' | 'id'>): string {
  return `${row.createdAt.getTime()}:${row.id}`;
}

export function decodeAuditCursor(raw: string): { createdAt: Date; id: string } | null {
  const separator = raw.indexOf(':');
  if (separator === -1) return null;

  const millis = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isFinite(millis) || !id) return null;

  return { createdAt: new Date(millis), id };
}

/**
 * Read one account's history, newest first. An event is "theirs" if they were
 * the actor or the subject — a responder investigating an account needs the
 * key-bundle fetch someone else performed against it just as much as the
 * device that account revoked itself.
 *
 * Ordered by (createdAt, id) descending so the cursor is stable when several
 * events share a millisecond.
 */
export async function queryAuditLog({
  userId,
  action,
  cursor,
  limit = DEFAULT_AUDIT_PAGE_SIZE,
}: AuditQuery): Promise<{ events: AuditLog[]; nextCursor: string | null; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(1, limit), MAX_AUDIT_PAGE_SIZE);
  const decoded = cursor ? decodeAuditCursor(cursor) : null;

  const conditions: Array<SQL | undefined> = [
    or(eq(auditLogs.subjectUserId, userId), eq(auditLogs.actorUserId, userId)),
  ];

  if (action) {
    conditions.push(eq(auditLogs.action, action));
  }

  if (decoded) {
    conditions.push(
      or(
        lt(auditLogs.createdAt, decoded.createdAt),
        and(eq(auditLogs.createdAt, decoded.createdAt), lt(auditLogs.id, decoded.id)),
      ),
    );
  }

  const rows = await db.query.auditLogs.findMany({
    where: and(...conditions),
    orderBy: [desc(auditLogs.createdAt), desc(auditLogs.id)],
    limit: pageSize + 1,
  });

  const hasMore = rows.length > pageSize;
  const events = hasMore ? rows.slice(0, pageSize) : rows;
  const last = events[events.length - 1];

  return {
    events,
    nextCursor: hasMore && last ? encodeAuditCursor(last) : null,
    hasMore,
  };
}
