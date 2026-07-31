/**
 * #369 — epoch sequencing, system events, and the catch-up path.
 *
 * The invariants under test: every group-control event bumps the epoch and
 * takes the next gap-free sequence, a client can fetch what it missed in
 * order, and two clients replaying the same log land on the same epoch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── an in-memory stand-in for the two tables under test ─────────────────────

interface ControlRow {
  id: string;
  conversationId: string;
  sequence: number;
  epoch: number;
  eventType: string;
  actorUserId: string | null;
  targetUserId: string | null;
  messageId: string | null;
  payload: string | null;
  createdAt: Date;
}

const store = {
  epochs: new Map<string, number>(),
  control: [] as ControlRow[],
  messages: [] as Array<Record<string, unknown>>,
};

let nextId = 0;
const makeId = () => `id-${++nextId}`;

/**
 * `select()` serves two shapes: `await ...where(...)` for the max-sequence
 * aggregate, and `...where(...).orderBy(...).limit(n)` for the ordered read.
 * The returned builder is thenable so both work off one implementation.
 */
function selectBuilder() {
  return {
    from: (_table: unknown) => ({
      where: (where: { conversationId?: string }) => {
        const conversationId = where.conversationId ?? currentQuery.conversationId;
        const forConversation = store.control.filter(
          (row) => row.conversationId === conversationId,
        );
        const maxSequence =
          forConversation.length > 0 ? Math.max(...forConversation.map((r) => r.sequence)) : 0;

        return {
          orderBy: (_order: unknown) => ({
            limit: async (limit: number) =>
              forConversation
                .filter((row) => row.sequence > currentQuery.sinceSequence)
                .sort((a, b) => a.sequence - b.sequence)
                .slice(0, limit),
          }),
          // Both aliases the service selects the aggregate under.
          then: (resolve: (rows: unknown) => unknown, reject?: (err: unknown) => unknown) =>
            Promise.resolve([{ maxSequence, latestSequence: maxSequence }]).then(resolve, reject),
        };
      },
    }),
  };
}

/** Captures which table a chained builder is operating on. */
function makeExecutor() {
  return {
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: (where: { conversationId: string }) => ({
          returning: async () => {
            const current = store.epochs.get(where.conversationId);
            if (current === undefined) return [];
            const next = current + 1;
            store.epochs.set(where.conversationId, next);
            return [{ epoch: next }];
          },
        }),
      }),
    }),
    select: (_columns: unknown) => selectBuilder(),
    insert: (table: { __name: string }) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (table.__name === 'messages') {
            const row = { id: makeId(), createdAt: new Date(), ...values };
            store.messages.push(row);
            return [row];
          }
          const row = {
            id: makeId(),
            createdAt: new Date(),
            ...values,
          } as unknown as ControlRow;
          store.control.push(row);
          return [row];
        },
      }),
    }),
  };
}

const mockConversationFindFirst = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversations: { findFirst: mockConversationFindFirst },
    },
    transaction: async (fn: (tx: unknown) => unknown) => fn(makeExecutor()),
    update: () => makeExecutor().update(null),
    insert: (table: { __name: string }) => makeExecutor().insert(table),
    select: () => selectBuilder(),
  },
}));

/** The read path builds its filter through mocked drizzle helpers. */
const currentQuery = { conversationId: '', sinceSequence: 0 };

vi.mock('../db/schema.js', () => ({
  conversations: { __name: 'conversations', id: 'id', epoch: 'epoch' },
  groupControlEvents: {
    __name: 'group_control_events',
    conversationId: 'conversationId',
    sequence: 'sequence',
  },
  messages: { __name: 'messages', id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => Object.assign({}, ...args.filter(Boolean)),
  asc: vi.fn(),
  eq: (col: unknown, val: unknown) => {
    if (col === 'conversationId' || col === 'id') {
      currentQuery.conversationId = String(val);
      return { conversationId: String(val) };
    }
    return {};
  },
  gt: (col: unknown, val: unknown) => {
    if (col === 'sequence') currentQuery.sinceSequence = Number(val);
    return {};
  },
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
let socketServer: unknown = { to: mockTo };

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => socketServer,
}));

vi.mock('../services/roomManager.js', () => ({
  conversationRoom: (id: string) => `conv:${id}`,
}));

const {
  appendGroupControlEvent,
  broadcastGroupControlEvent,
  readGroupControlEvents,
  getGroupState,
  buildSystemEventBody,
  serializeGroupControlEvent,
} = await import('../services/groupControl.js');

const CONV = 'conv-1';

beforeEach(() => {
  vi.clearAllMocks();
  store.epochs = new Map([[CONV, 0]]);
  store.control = [];
  store.messages = [];
  nextId = 0;
  socketServer = { to: mockTo };
  currentQuery.conversationId = '';
  currentQuery.sinceSequence = 0;
  mockConversationFindFirst.mockImplementation(async () => ({ epoch: store.epochs.get(CONV) }));
});

// ─── appending ────────────────────────────────────────────────────────────────

describe('appendGroupControlEvent', () => {
  it('AC2 — bumps the epoch and records what changed', async () => {
    const { event } = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_added',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });

    expect(event).toMatchObject({
      conversationId: CONV,
      sequence: 1,
      epoch: 1,
      eventType: 'member_added',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });
    expect(store.epochs.get(CONV)).toBe(1);
  });

  it('assigns gap-free sequences and a monotonic epoch across events', async () => {
    const first = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_added',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });
    const second = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_left',
      actorUserId: 'user-2',
      targetUserId: 'user-2',
    });
    const third = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'commit',
      actorUserId: 'user-1',
      payload: 'opaque-mls-commit',
    });

    expect([first, second, third].map((r) => r.event.sequence)).toEqual([1, 2, 3]);
    expect([first, second, third].map((r) => r.event.epoch)).toEqual([1, 2, 3]);
  });

  it('AC2 — writes a content_type=system message describing the change', async () => {
    const { systemMessage, event } = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_added',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });

    expect(systemMessage).toMatchObject({
      conversationId: CONV,
      senderId: 'user-1',
      contentType: 'system',
    });
    expect(JSON.parse(String(systemMessage!['ciphertext']))).toEqual({
      type: 'group_control',
      eventType: 'member_added',
      conversationId: CONV,
      epoch: 1,
      sequence: 1,
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });
    // The control row and the timeline entry point at each other, so the two
    // views of the change can never disagree.
    expect(event.messageId).toBe(systemMessage!['id']);
  });

  it('stores a client commit payload verbatim without interpreting it', async () => {
    const payload = JSON.stringify({ anything: 'the server does not parse' });

    const { event } = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'commit',
      actorUserId: 'user-1',
      payload,
    });

    expect(event.payload).toBe(payload);
  });

  it('fails loudly when the conversation is gone rather than losing the event', async () => {
    await expect(
      appendGroupControlEvent({
        conversationId: 'missing-conversation',
        eventType: 'commit',
        actorUserId: 'user-1',
      }),
    ).rejects.toThrow(/not found/);
  });
});

// ─── broadcasting ─────────────────────────────────────────────────────────────

describe('broadcastGroupControlEvent', () => {
  it('AC2 — emits the system event, the epoch change and the timeline entry', async () => {
    const appended = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_added',
      actorUserId: 'user-1',
      targetUserId: 'user-2',
    });

    broadcastGroupControlEvent(appended);

    // Both the optimized room and the plain conversation id, for compatibility.
    expect(mockTo).toHaveBeenCalledWith(`conv:${CONV}`);
    expect(mockTo).toHaveBeenCalledWith(CONV);

    const emitted = mockEmit.mock.calls.map(([name]) => name);
    expect(emitted).toContain('group_system_event');
    expect(emitted).toContain('epoch_changed');
    expect(emitted).toContain('new_message');

    expect(mockEmit).toHaveBeenCalledWith('epoch_changed', {
      conversationId: CONV,
      epoch: 1,
      sequence: 1,
    });
  });

  it('is a no-op without a socket server, so the durable log still stands', async () => {
    socketServer = null;
    const appended = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'commit',
      actorUserId: 'user-1',
    });

    expect(() => broadcastGroupControlEvent(appended)).not.toThrow();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('describes the change in one stable shape', async () => {
    const { event } = await appendGroupControlEvent({
      conversationId: CONV,
      eventType: 'member_left',
      actorUserId: 'user-2',
      targetUserId: 'user-2',
    });

    expect(buildSystemEventBody(event)).toEqual({
      type: 'group_control',
      eventType: 'member_left',
      conversationId: CONV,
      epoch: 1,
      sequence: 1,
      actorUserId: 'user-2',
      targetUserId: 'user-2',
    });
    expect(serializeGroupControlEvent(event)).toMatchObject({
      sequence: 1,
      epoch: 1,
      eventType: 'member_left',
    });
  });
});

// ─── catch-up ─────────────────────────────────────────────────────────────────

describe('AC1 — missed commits are retrievable in order', () => {
  async function seed(count: number) {
    for (let i = 0; i < count; i++) {
      await appendGroupControlEvent({
        conversationId: CONV,
        eventType: 'commit',
        actorUserId: 'user-1',
        payload: `commit-${i + 1}`,
      });
    }
  }

  it('returns everything after the cursor, oldest first', async () => {
    await seed(5);

    const { events, hasMore } = await readGroupControlEvents({
      conversationId: CONV,
      sinceSequence: 2,
    });

    expect(events.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(hasMore).toBe(false);
  });

  it('treats the cursor as exclusive, so replaying never re-applies an event', async () => {
    await seed(3);

    const { events } = await readGroupControlEvents({
      conversationId: CONV,
      sinceSequence: 3,
    });

    expect(events).toEqual([]);
  });

  it('returns the whole log for a client that has never synced', async () => {
    await seed(3);

    const { events } = await readGroupControlEvents({ conversationId: CONV });

    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('pages without dropping an event between pages', async () => {
    await seed(5);

    const first = await readGroupControlEvents({ conversationId: CONV, limit: 2 });
    expect(first.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);

    const second = await readGroupControlEvents({
      conversationId: CONV,
      sinceSequence: first.events[first.events.length - 1]!.sequence,
      limit: 2,
    });
    expect(second.events.map((e) => e.sequence)).toEqual([3, 4]);

    const third = await readGroupControlEvents({
      conversationId: CONV,
      sinceSequence: second.events[second.events.length - 1]!.sequence,
      limit: 2,
    });
    expect(third.events.map((e) => e.sequence)).toEqual([5]);
    expect(third.hasMore).toBe(false);
  });

  it('AC3 — a client that missed everything converges on the current epoch', async () => {
    await seed(4);

    const state = await getGroupState(CONV);
    const { events } = await readGroupControlEvents({ conversationId: CONV, sinceSequence: 0 });

    // Replay in order, exactly as a catching-up client would.
    let clientEpoch = 0;
    let clientSequence = 0;
    for (const event of events) {
      expect(event.sequence).toBe(clientSequence + 1); // gap-free
      clientSequence = event.sequence;
      clientEpoch = event.epoch;
    }

    expect(clientEpoch).toBe(state!.epoch);
    expect(clientSequence).toBe(state!.latestSequence);
  });

  it('AC3 — a client that saw the live events lands on the same epoch as one that replayed', async () => {
    await seed(3);

    const live = store.control[store.control.length - 1]!.epoch;
    const { events } = await readGroupControlEvents({ conversationId: CONV, sinceSequence: 0 });
    const replayed = events[events.length - 1]!.epoch;

    expect(replayed).toBe(live);
  });

  it('reports where the group stands for an "am I behind?" check', async () => {
    await seed(2);

    expect(await getGroupState(CONV)).toEqual({ epoch: 2, latestSequence: 2 });
  });

  it('reports a fresh conversation as epoch zero with nothing to replay', async () => {
    expect(await getGroupState(CONV)).toEqual({ epoch: 0, latestSequence: 0 });
  });

  it('returns null for a conversation that does not exist', async () => {
    mockConversationFindFirst.mockResolvedValue(undefined);

    expect(await getGroupState('missing-conversation')).toBeNull();
  });
});
