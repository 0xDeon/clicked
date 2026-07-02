import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      messages: { findFirst: vi.fn() },
      userDevices: { findMany: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: {},
  messages: {},
  messageEnvelopes: {},
  userDevices: {},
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

// Truthy redis so the resume handler takes the replay path.
vi.mock('../lib/redis.js', () => ({ redis: {} }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

const mockReadMissed = vi.fn();
const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/resumeStream.js', () => ({
  readMissedEvents: mockReadMissed,
  publishEphemeral: mockPublish,
}));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId: string) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];
  return Object.assign(emitter, {
    auth: { userId, deviceId: 'device-1' },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    join: vi.fn(),
    emitted,
  });
}

function makeIo() {
  const emitFn = vi.fn();
  return { to: vi.fn(() => ({ emit: emitFn, volatile: { emit: emitFn } })) };
}

async function getHandler(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return socket.listeners('resume')[0] as (p: unknown) => Promise<void>;
}

const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resume socket event', () => {
  it('replays the missed ephemeral events and signals a message sync', async () => {
    mockReadMissed.mockResolvedValue([
      { id: '1-0', type: 'read_receipt', data: { conversationId: 'c1' } },
      { id: '2-0', type: 'presence_update', data: { online: true } },
    ]);

    const socket = makeSocket(USER_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({ lastEventId: '0-1' });

    expect(socket.emit).toHaveBeenCalledWith('ephemeral_replay', {
      id: '1-0',
      type: 'read_receipt',
      data: { conversationId: 'c1' },
    });
    expect(socket.emit).toHaveBeenCalledWith('ephemeral_replay', {
      id: '2-0',
      type: 'presence_update',
      data: { online: true },
    });
    // Durable messages are recovered via sync, never via the resume stream.
    expect(socket.emit).toHaveBeenCalledWith('resume_complete', {
      lastEventId: '2-0',
      syncRequired: true,
    });
  });

  it('reads from an exclusive cursor so replay is idempotent', async () => {
    mockReadMissed.mockResolvedValue([]);

    const socket = makeSocket(USER_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({ lastEventId: '7-0' });

    expect(mockReadMissed).toHaveBeenCalledWith(expect.anything(), USER_ID, '7-0');
    // Nothing missed: no replays, cursor unchanged, still asks for a sync.
    const replays = socket.emitted.filter((e) => e.event === 'ephemeral_replay');
    expect(replays).toHaveLength(0);
    expect(socket.emit).toHaveBeenCalledWith('resume_complete', {
      lastEventId: '7-0',
      syncRequired: true,
    });
  });

  it('treats a missing lastEventId as a full replay from the start', async () => {
    mockReadMissed.mockResolvedValue([]);

    const socket = makeSocket(USER_ID);
    const handler = await getHandler(socket, makeIo());

    await handler({});

    expect(mockReadMissed).toHaveBeenCalledWith(expect.anything(), USER_ID, '');
    expect(socket.emit).toHaveBeenCalledWith('resume_complete', {
      lastEventId: null,
      syncRequired: true,
    });
  });
});
