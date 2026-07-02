/**
 * Resume protocol — missed ephemeral-event replay (#200).
 *
 * Lightweight, non-durable events (read/delivery receipts, presence changes,
 * system notices) are appended to a short-lived per-user Redis stream as they
 * are emitted live. When a device reconnects it sends `resume { lastEventId }`
 * and the gateway replays everything recorded after that id, then tells the
 * client to run a full envelope sync for the durable messages it missed.
 *
 * Durable chat messages live in Postgres and are deliberately NEVER written to
 * this stream — they are recovered through message/envelope sync, keeping the
 * stream cheap and bounded.
 *
 * The stream is keyed per user; each device tracks its own `lastEventId`
 * cursor, so two devices of the same user resume independently. Redis stream
 * ids are monotonic and unique, which makes them the natural event id clients
 * persist. Replay uses an exclusive range, so re-issuing `resume` with an
 * advanced cursor never re-delivers an event the client already saw.
 */
import type { Redis } from 'ioredis';

/** Streams expire after this many seconds of inactivity. Long enough to cover
 *  transient disconnects (network blips, app backgrounding) without retaining
 *  ephemeral chatter indefinitely. */
export const RESUME_STREAM_TTL_SECONDS = 300;

/** Hard cap on backlog length per user. Approximate trimming (`MAXLEN ~`) keeps
 *  XADD O(1) while bounding memory. */
export const RESUME_STREAM_MAXLEN = 500;

export interface EphemeralEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ReplayedEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export function eventStreamKey(userId: string): string {
  return `resume:events:${userId}`;
}

/**
 * Append a single ephemeral event to a user's replay stream and return the
 * generated stream id. The id is what the client stores as `lastEventId`.
 */
export async function recordEphemeralEvent(
  redis: Redis,
  userId: string,
  event: EphemeralEvent,
): Promise<string | null> {
  const key = eventStreamKey(userId);
  const id = await redis.xadd(
    key,
    'MAXLEN',
    '~',
    RESUME_STREAM_MAXLEN,
    '*',
    'type',
    event.type,
    'data',
    JSON.stringify(event.data),
  );
  await redis.expire(key, RESUME_STREAM_TTL_SECONDS);
  return id;
}

/**
 * Fan an ephemeral event out to every recipient's stream. Recording is
 * best-effort: a Redis failure for one recipient must not block live delivery
 * or the others. No-op when Redis is unavailable.
 */
export async function publishEphemeral(
  redis: Redis | null,
  recipientUserIds: string[],
  event: EphemeralEvent,
): Promise<void> {
  if (!redis || recipientUserIds.length === 0) {
    return;
  }
  const client = redis;
  await Promise.allSettled(
    [...new Set(recipientUserIds)].map((userId) => recordEphemeralEvent(client, userId, event)),
  );
}

/**
 * Read every ephemeral event recorded after `lastEventId` (exclusive). When
 * `lastEventId` is empty the whole retained stream is returned. The exclusive
 * lower bound is what makes replay idempotent.
 */
export async function readMissedEvents(
  redis: Redis,
  userId: string,
  lastEventId: string,
): Promise<ReplayedEvent[]> {
  const key = eventStreamKey(userId);
  const start = lastEventId ? `(${lastEventId}` : '-';
  const entries = await redis.xrange(key, start, '+');

  return entries.map(([id, fields]) => ({
    id,
    type: readField(fields, 'type'),
    data: parseData(readField(fields, 'data')),
  }));
}

function readField(fields: string[], name: string): string {
  const idx = fields.indexOf(name);
  return idx >= 0 ? (fields[idx + 1] ?? '') : '';
}

function parseData(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
