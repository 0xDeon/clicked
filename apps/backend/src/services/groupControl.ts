/**
 * Group epoch sequencing and system events (#369).
 *
 * Group state — who is a member, which epoch's keys are current — is only
 * usable if every client applies the same changes in the same order. Chat
 * messages are ordered by `(createdAt, id)`, which is fine for a timeline but
 * not for group control: two clients that apply a join and a leave in
 * different orders derive different state, and a timestamp cursor can silently
 * skip an event written slightly out of clock order.
 *
 * So group control gets its own log with a strictly monotonic, gap-free
 * `sequence` per conversation. A client that missed commits asks for
 * everything after the last sequence it applied and replays in order; "am I
 * behind?" is an integer comparison, not a guess.
 *
 * Serialization: `conversations.epoch` is bumped with an `UPDATE ... RETURNING`
 * inside the same transaction that assigns the sequence. That update takes a
 * row lock on the conversation, so a concurrent join and leave are forced into
 * a real order rather than racing for the same sequence number — the unique
 * index on `(conversationId, sequence)` is the backstop, not the mechanism.
 *
 * Every event also persists a `content_type='system'` message so the change
 * appears in the conversation timeline, and is fanned out live as
 * `group_system_event` + `epoch_changed`.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  conversations,
  groupControlEvents,
  messages,
  type GroupControlEvent,
  type GroupControlEventType,
  type Message,
} from '../db/schema.js';
import { getSocketServer } from '../lib/socket.js';
import { conversationRoom } from './roomManager.js';

/** Maximum size of an opaque client-submitted commit payload. */
export const MAX_GROUP_CONTROL_PAYLOAD_BYTES = 64 * 1024;

/** Default and maximum page sizes for the catch-up endpoint. */
export const DEFAULT_GROUP_CONTROL_PAGE_SIZE = 100;
export const MAX_GROUP_CONTROL_PAGE_SIZE = 500;

export interface AppendGroupControlInput {
  conversationId: string;
  eventType: GroupControlEventType;
  actorUserId?: string | null;
  targetUserId?: string | null;
  /** Opaque MLS material. Never inspected. */
  payload?: string | null;
}

/**
 * The body of the `content_type='system'` message written for an event. Kept
 * as one shape so a client can parse any system message the same way, and
 * deliberately free of anything private — it is stored unencrypted, exactly
 * like the existing device-change system messages.
 */
export interface GroupSystemEventBody {
  type: 'group_control';
  eventType: GroupControlEventType;
  conversationId: string;
  epoch: number;
  sequence: number;
  actorUserId: string | null;
  targetUserId: string | null;
}

export function buildSystemEventBody(event: GroupControlEvent): GroupSystemEventBody {
  return {
    type: 'group_control',
    eventType: event.eventType,
    conversationId: event.conversationId,
    epoch: event.epoch,
    sequence: event.sequence,
    actorUserId: event.actorUserId,
    targetUserId: event.targetUserId,
  };
}

export interface AppendedGroupControl {
  event: GroupControlEvent;
  /** The timeline entry written for the event, when the event had an actor. */
  systemMessage: Message | null;
}

/** The transaction handle drizzle hands to a `db.transaction` callback. */
export type GroupControlTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Append one group-control event: bump the epoch, assign the next sequence,
 * write the system message, and link the two.
 *
 * Pass `existingTx` to run inside a caller's transaction — membership routes
 * do, so a join either lands with its epoch bump or not at all. A membership
 * row committed without its control event would leave every other client
 * permanently unaware of a member who can now decrypt, which is exactly the
 * divergence this log exists to prevent.
 */
export async function appendGroupControlEvent(
  input: AppendGroupControlInput,
  existingTx?: GroupControlTx,
): Promise<AppendedGroupControl> {
  const { conversationId, eventType } = input;
  const actorUserId = input.actorUserId ?? null;
  const targetUserId = input.targetUserId ?? null;
  const payload = input.payload ?? null;

  const run = async (tx: GroupControlTx): Promise<AppendedGroupControl> => {
    // Row-locks the conversation for the rest of the transaction, which is
    // what makes the sequence assignment below safe under concurrency.
    const [updated] = await tx
      .update(conversations)
      .set({ epoch: sql`${conversations.epoch} + 1` })
      .where(eq(conversations.id, conversationId))
      .returning({ epoch: conversations.epoch });

    if (!updated) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const [maxRow] = await tx
      .select({ maxSequence: sql<number>`coalesce(max(${groupControlEvents.sequence}), 0)` })
      .from(groupControlEvents)
      .where(eq(groupControlEvents.conversationId, conversationId));

    const sequence = Number(maxRow?.maxSequence ?? 0) + 1;

    // The system message is written first so the control row can point at it;
    // an actor-less event (a server-driven change) still needs a sender, so
    // those are not given a timeline entry.
    let systemMessage: Message | null = null;
    if (actorUserId) {
      const [inserted] = await tx
        .insert(messages)
        .values({
          conversationId,
          senderId: actorUserId,
          contentType: 'system',
          ciphertext: JSON.stringify({
            type: 'group_control',
            eventType,
            conversationId,
            epoch: updated.epoch,
            sequence,
            actorUserId,
            targetUserId,
          } satisfies GroupSystemEventBody),
        })
        .returning();
      systemMessage = inserted ?? null;
    }

    const [event] = await tx
      .insert(groupControlEvents)
      .values({
        conversationId,
        sequence,
        epoch: updated.epoch,
        eventType,
        actorUserId,
        targetUserId,
        messageId: systemMessage?.id ?? null,
        payload,
      })
      .returning();

    if (!event) {
      throw new Error('Failed to append group control event');
    }

    return { event, systemMessage };
  };

  return existingTx ? run(existingTx) : db.transaction(run);
}

/**
 * Fan an appended event out to everyone currently connected. Best-effort and
 * deliberately after the transaction commits: the durable log is the source of
 * truth, and a client that misses the live event catches up through
 * `readGroupControlEvents`.
 */
export function broadcastGroupControlEvent({ event, systemMessage }: AppendedGroupControl): void {
  const io = getSocketServer();
  if (!io) return;

  const body = buildSystemEventBody(event);
  // Both the optimized fan-out room and the plain conversation id, matching
  // how the rest of the gateway emits for backward compatibility.
  const rooms = [conversationRoom(event.conversationId), event.conversationId];

  for (const room of rooms) {
    io.to(room).emit('group_system_event', { id: event.id, ...body, createdAt: event.createdAt });
    io.to(room).emit('epoch_changed', {
      conversationId: event.conversationId,
      epoch: event.epoch,
      sequence: event.sequence,
    });
    // Existing clients render the timeline from `new_message`, so the system
    // entry has to arrive on that channel too.
    if (systemMessage) {
      io.to(room).emit('new_message', systemMessage);
    }
  }
}

/**
 * Ordered catch-up read. Returns every event after `sinceSequence`, oldest
 * first — the order a client must replay them in. `sinceSequence` is
 * exclusive, so re-issuing the same cursor never re-delivers an applied event.
 */
export async function readGroupControlEvents({
  conversationId,
  sinceSequence = 0,
  limit = DEFAULT_GROUP_CONTROL_PAGE_SIZE,
}: {
  conversationId: string;
  sinceSequence?: number;
  limit?: number;
}): Promise<{ events: GroupControlEvent[]; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(1, limit), MAX_GROUP_CONTROL_PAGE_SIZE);

  const rows = await db
    .select()
    .from(groupControlEvents)
    .where(
      and(
        eq(groupControlEvents.conversationId, conversationId),
        gt(groupControlEvents.sequence, sinceSequence),
      ),
    )
    .orderBy(asc(groupControlEvents.sequence))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;

  return { events: hasMore ? rows.slice(0, pageSize) : rows, hasMore };
}

/**
 * Where the conversation currently stands. `latestSequence` is what a client
 * compares its own cursor against to decide whether it needs to catch up.
 */
export async function getGroupState(
  conversationId: string,
): Promise<{ epoch: number; latestSequence: number } | null> {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { epoch: true },
  });

  if (!conversation) return null;

  const [row] = await db
    .select({ latestSequence: sql<number>`coalesce(max(${groupControlEvents.sequence}), 0)` })
    .from(groupControlEvents)
    .where(eq(groupControlEvents.conversationId, conversationId));

  return {
    epoch: conversation.epoch,
    latestSequence: Number(row?.latestSequence ?? 0),
  };
}

/** Shape returned to clients. Keeps the wire format in one place. */
export function serializeGroupControlEvent(event: GroupControlEvent) {
  return {
    id: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    epoch: event.epoch,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    targetUserId: event.targetUserId,
    messageId: event.messageId,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}
