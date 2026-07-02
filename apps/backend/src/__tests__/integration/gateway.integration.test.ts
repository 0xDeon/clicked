/**
 * Gateway integration tests — issue #215
 *
 * Spins up two Socket.IO gateway instances sharing a real Redis instance to
 * assert the following acceptance criteria:
 *
 *   1. Cross-node delivery   — message sent on node-1 arrives on node-2
 *   2. Multi-device fanout   — every active device of a user receives the envelope
 *   3. Persist-before-deliver — DB write completes before new_message is broadcast
 *   4. Revocation disconnect  — a device revoked via Redis pub/sub is force-disconnected
 *   5. Resume/sync after drop — missed ephemeral events are replayed on reconnect
 *
 * Requires Redis at REDIS_URL (default redis://localhost:6379).
 * Start one locally with: docker run -p 6379:6379 redis:7-alpine
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';

// ── hoisted redis reference ───────────────────────────────────────────────────
//
// vi.hoisted executes before vi.mock factories and before any import, so we
// can close over this reference in the redis mock factory below.

const redisRef = vi.hoisted(() => ({ instance: null as Redis | null }));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
      conversationMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      messages: { findFirst: vi.fn(), findMany: vi.fn() },
      userDevices: { findMany: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema.js', () => ({
  devices: {},
  conversations: {},
  conversationMembers: {},
  messages: {},
  messageEnvelopes: {},
  userDevices: {},
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn(),
  ne: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

// Expose our test Redis instance through the module singleton so that
// presence, resume-stream, and rate-limit services all talk to the same
// Redis used by the Socket.IO adapter.
vi.mock('../../lib/redis.js', () => ({
  get redis() {
    return redisRef.instance;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

vi.mock('../../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

// Allow every event through — rate limiting is tested independently.
vi.mock('../../services/rateLimit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPayloadSize: vi.fn().mockReturnValue({ valid: true, size: 0 }),
  recordViolation: vi.fn().mockReturnValue(0),
  clearViolations: vi.fn(),
}));

vi.mock('../../services/heartbeat.js', () => ({
  startHeartbeatTimer: vi.fn(),
  clearHeartbeatTimer: vi.fn(),
}));

vi.mock('../../services/backpressure.js', () => ({
  registerForBackpressure: vi.fn(),
  unregisterForBackpressure: vi.fn(),
}));

// ── imports (resolved after mocks are registered) ─────────────────────────────

import { db } from '../../db/index.js';
import { socketAuthMiddleware } from '../../middleware/socketAuth.js';
import { registerMessagingHandlers } from '../../socket/messaging.js';
import {
  registerDeviceSocket,
  unregisterDeviceSocket,
  startDeviceRevocationListener,
} from '../../services/deviceRevocation.js';
import { setOnline, setOffline } from '../../services/presence.js';
import { recordEphemeralEvent } from '../../services/resumeStream.js';
import { setSocketServer } from '../../lib/socket.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-for-ci-only';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CONV_ID = 'conv-integration-215';

// Port range reserved for this suite — avoids clashes with other listeners.
const BASE_PORT = 14400;

const ALICE = { userId: 'user-alice', deviceId: 'device-alice', walletAddress: '0xaaa' };
const ALICE2 = { userId: 'user-alice', deviceId: 'device-alice-2', walletAddress: '0xaaa' };
const BOB = { userId: 'user-bob', deviceId: 'device-bob', walletAddress: '0xbbb' };
const CAROL = { userId: 'user-carol', deviceId: 'device-carol', walletAddress: '0xccc' };

function makeToken(u: { userId: string; deviceId: string; walletAddress: string }): string {
  return jwt.sign(u, JWT_SECRET, { expiresIn: '1h' });
}

// ── gateway factory ───────────────────────────────────────────────────────────

interface GatewayNode {
  io: Server;
  port: number;
  close: () => Promise<void>;
}

async function createGatewayNode(port: number, redis: Redis): Promise<GatewayNode> {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });

  const pub = redis.duplicate();
  const sub = redis.duplicate();

  io.adapter(createAdapter(pub, sub));

  io.use(socketAuthMiddleware);

  io.on('connection', async (socket) => {
    const { userId, deviceId } = (socket as { auth?: { userId: string; deviceId: string } }).auth!;

    registerDeviceSocket(deviceId, socket.id);
    await setOnline(redis, userId, socket.id);

    // Auto-join every conversation the user belongs to (mirrors index.ts).
    // Our mock distinguishes connection-time calls (no query arg) from
    // send_message calls (passes a where clause) via mockImplementation below.
    const memberships = (await vi.mocked(db.query.conversationMembers.findMany)()) as Array<{
      conversationId: string;
    }>;
    for (const m of memberships) {
      await socket.join(m.conversationId);
    }

    registerMessagingHandlers(io, socket as never);

    socket.on('disconnect', async () => {
      unregisterDeviceSocket(socket.id);
      await setOffline(redis, userId, socket.id);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  return {
    io,
    port,
    close: async () => {
      io.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      await pub.quit().catch(() => {});
      await sub.quit().catch(() => {});
    },
  };
}

// ── test helpers ──────────────────────────────────────────────────────────────

function connect(port: number, user: typeof ALICE): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: { token: makeToken(user) },
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function waitFor<T = unknown>(socket: ClientSocket, event: string, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}" on socket ${socket.id}`)),
      ms,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Propagate a short pause so the Redis adapter can sync room subscriptions
// across nodes before we send events.
const adapterSync = () => new Promise((r) => setTimeout(r, 150));

// ── mock configurators ────────────────────────────────────────────────────────

function mockDevice(user: typeof ALICE, isRevoked = false) {
  vi.mocked(db.query.devices.findFirst).mockResolvedValue({
    id: user.deviceId,
    userId: user.userId,
    isRevoked,
  } as never);
}

// Connection-time findMany (no args) → returns conversationId entries.
// send_message findMany (with args) → returns userId entries for cache invalidation.
function mockMemberships(convIds: string[], members: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.query.conversationMembers.findMany as any).mockImplementation(async (query?: unknown) =>
    query ? members.map((userId) => ({ userId })) : convIds.map((c) => ({ conversationId: c })),
  );
}

function mockInsertMessage(msg: {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  ciphertext: string;
  sequenceNumber?: number;
}) {
  const row = {
    ...msg,
    contentType: 'text/plain',
    sequenceNumber: msg.sequenceNumber ?? 1,
    createdAt: new Date(),
  };
  const returning = vi.fn().mockResolvedValue([row]);
  vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) } as never);
  return { returning, row };
}

// ─────────────────────────────────────────────────────────────────────────────

// ioredis internally rejects pending-command Promises when a connection closes.
// Those rejections are not catchable on the quit() promise itself — they surface
// as unhandled rejections from ioredis's event_handler.js.  Register a handler
// that silences only this specific message so Vitest doesn't report it as an
// error while still letting genuine unhandled rejections propagate.
const suppressConnectionClosed = (err: unknown) => {
  if (err instanceof Error && err.message === 'Connection is closed.') return;
  throw err;
};

describe('Gateway integration — issue #215', () => {
  let redis: Redis;

  beforeAll(async () => {
    process.on('unhandledRejection', suppressConnectionClosed);
    redis = new Redis(REDIS_URL, { lazyConnect: true });
    await redis.connect();
    redisRef.instance = redis;
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
    process.off('unhandledRejection', suppressConnectionClosed);
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up db.select chain for deliverMessage (deliveryPipeline.ts).
    // deliverMessage queries members then activeDevices via db.select().from().where().
    // Returning non-empty members + empty activeDevices causes it to call
    // io.to(conversationId).emit('new_message', message) — the path tests expect.
    const mockWhere = vi
      .fn()
      .mockResolvedValueOnce([{ userId: ALICE.userId }]) // members query
      .mockResolvedValue([]); // activeDevices query → triggers new_message emit
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockWhere }),
    } as never);

    // Flush all keys written by this suite so tests are hermetically isolated.
    const patterns = [
      `presence:${ALICE.userId}`,
      `presence:${ALICE2.userId}`,
      `presence:${BOB.userId}`,
      `presence:${CAROL.userId}`,
      `resume:events:${ALICE.userId}`,
      `resume:events:${BOB.userId}`,
      `resume:events:${CAROL.userId}`,
    ];
    const existing = (await Promise.all(patterns.map((k) => redis.exists(k)))).flatMap((e, i) =>
      e ? [patterns[i]!] : [],
    );
    if (existing.length) await redis.del(...existing);
  });

  // ── 1. Cross-node delivery ──────────────────────────────────────────────────

  describe('cross-node delivery', () => {
    it('delivers a message from a socket on node-1 to a socket on node-2', async () => {
      const node1 = await createGatewayNode(BASE_PORT, redis);
      const node2 = await createGatewayNode(BASE_PORT + 1, redis);

      try {
        const MSG_ID = 'msg-cross-node-215';

        // Alice on node-1, Bob on node-2 — both belong to CONV_ID.
        mockDevice(ALICE);
        mockMemberships([CONV_ID], [ALICE.userId, BOB.userId]);
        const clientAlice = await connect(node1.port, ALICE);

        mockDevice(BOB);
        const clientBob = await connect(node2.port, BOB);

        // Allow the Redis adapter to propagate room subscriptions across nodes.
        await adapterSync();

        // Configure DB for send_message.
        vi.mocked(db.query.conversationMembers.findFirst).mockResolvedValue({
          id: 'm1',
          userId: ALICE.userId,
          conversationId: CONV_ID,
        } as never);
        vi.mocked(db.query.messages.findFirst).mockResolvedValue(undefined);
        vi.mocked(db.query.userDevices.findMany).mockResolvedValue([] as never);
        mockInsertMessage({
          id: MSG_ID,
          conversationId: CONV_ID,
          senderId: ALICE.userId,
          senderDeviceId: ALICE.deviceId,
          ciphertext: 'hello from node-1',
        });

        const bobReceived = waitFor<{ id: string; conversationId: string }>(
          clientBob,
          'new_message',
        );

        clientAlice.emit('send_message', {
          conversationId: CONV_ID,
          messageId: MSG_ID,
          ciphertext: 'hello from node-1',
        });

        const msg = await bobReceived;
        expect(msg.id).toBe(MSG_ID);
        expect(msg.conversationId).toBe(CONV_ID);

        clientAlice.disconnect();
        clientBob.disconnect();
      } finally {
        await node1.close();
        await node2.close();
      }
    });
  });

  // ── 2. Multi-device fanout ──────────────────────────────────────────────────

  describe('multi-device fanout', () => {
    it('delivers a message to every active device of the recipient user', async () => {
      const node1 = await createGatewayNode(BASE_PORT + 2, redis);
      const node2 = await createGatewayNode(BASE_PORT + 3, redis);

      try {
        const MSG_ID = 'msg-fanout-215';

        // Alice's device-1 on node-1 and device-2 on node-2.
        mockDevice(ALICE);
        mockMemberships([CONV_ID], [ALICE.userId, BOB.userId]);
        const aliceD1 = await connect(node1.port, ALICE);

        mockDevice(ALICE2);
        const aliceD2 = await connect(node2.port, ALICE2);

        // Bob sends from node-1.
        mockDevice(BOB);
        const clientBob = await connect(node1.port, BOB);

        await adapterSync();

        vi.mocked(db.query.conversationMembers.findFirst).mockResolvedValue({
          id: 'm1',
          userId: BOB.userId,
          conversationId: CONV_ID,
        } as never);
        vi.mocked(db.query.messages.findFirst).mockResolvedValue(undefined);
        vi.mocked(db.query.userDevices.findMany).mockResolvedValue([
          { id: ALICE.deviceId, userId: ALICE.userId },
          { id: ALICE2.deviceId, userId: ALICE.userId },
        ] as never);

        // db.insert is called twice: messages then messageEnvelopes.
        // Both need to return a chainable object; only messages.returning() matters.
        const msgRow = {
          id: MSG_ID,
          conversationId: CONV_ID,
          senderId: BOB.userId,
          senderDeviceId: BOB.deviceId,
          ciphertext: 'broadcast',
          contentType: 'text/plain',
          sequenceNumber: 1,
          createdAt: new Date(),
        };
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([msgRow]) }),
        } as never);

        const d1Promise = waitFor<{ id: string }>(aliceD1, 'new_message');
        const d2Promise = waitFor<{ id: string }>(aliceD2, 'new_message');

        clientBob.emit('send_message', {
          conversationId: CONV_ID,
          messageId: MSG_ID,
          ciphertext: 'broadcast',
          envelopes: [
            { recipientDeviceId: ALICE.deviceId, ciphertext: 'for-device-1' },
            { recipientDeviceId: ALICE2.deviceId, ciphertext: 'for-device-2' },
          ],
        });

        const [msg1, msg2] = await Promise.all([d1Promise, d2Promise]);
        expect(msg1.id).toBe(MSG_ID);
        expect(msg2.id).toBe(MSG_ID);

        aliceD1.disconnect();
        aliceD2.disconnect();
        clientBob.disconnect();
      } finally {
        await node1.close();
        await node2.close();
      }
    });
  });

  // ── 3. Persist-before-deliver ──────────────────────────────────────────────

  describe('persist-before-deliver', () => {
    it('completes the DB insert before broadcasting new_message to peers', async () => {
      const node1 = await createGatewayNode(BASE_PORT + 4, redis);

      try {
        const MSG_ID = 'msg-persist-215';
        const order: string[] = [];

        mockDevice(ALICE);
        mockMemberships([CONV_ID], [ALICE.userId, BOB.userId]);
        const clientAlice = await connect(node1.port, ALICE);

        mockDevice(BOB);
        const clientBob = await connect(node1.port, BOB);

        await adapterSync();

        vi.mocked(db.query.conversationMembers.findFirst).mockResolvedValue({
          id: 'm1',
          userId: ALICE.userId,
          conversationId: CONV_ID,
        } as never);
        vi.mocked(db.query.messages.findFirst).mockResolvedValue(undefined);
        vi.mocked(db.query.userDevices.findMany).mockResolvedValue([] as never);

        // Introduce latency on the returning() step to prove ordering.
        const returning = vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 30));
          order.push('db_insert_done');
          return [
            {
              id: MSG_ID,
              conversationId: CONV_ID,
              senderId: ALICE.userId,
              senderDeviceId: ALICE.deviceId,
              ciphertext: 'persist-test',
              contentType: 'text/plain',
              sequenceNumber: 99,
              createdAt: new Date(),
            },
          ];
        });
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnValue({ returning }),
        } as never);

        const bobMessage = waitFor<{ id: string; sequenceNumber: number }>(
          clientBob,
          'new_message',
        ).then((m) => {
          order.push('new_message_received');
          return m;
        });

        clientAlice.emit('send_message', {
          conversationId: CONV_ID,
          messageId: MSG_ID,
          ciphertext: 'persist-before-deliver',
        });

        const received = await bobMessage;

        expect(returning).toHaveBeenCalledOnce();
        expect(order).toEqual(['db_insert_done', 'new_message_received']);
        expect(received.sequenceNumber).toBe(99);

        clientAlice.disconnect();
        clientBob.disconnect();
      } finally {
        await node1.close();
      }
    });
  });

  // ── 4. Revocation disconnect ───────────────────────────────────────────────

  describe('revocation disconnect', () => {
    it('disconnects and notifies a socket when its device is revoked cross-node', async () => {
      const node = await createGatewayNode(BASE_PORT + 5, redis);

      // Register this node's io as the socket server so the revocation listener
      // can look up sockets by ID.
      setSocketServer(node.io);

      // Dedicated subscriber Redis client (ioredis becomes subscriber-only
      // after psubscribe, so we must not reuse the main redis instance).
      const revSub = redis.duplicate();
      await startDeviceRevocationListener(revSub, redis);

      try {
        mockDevice(CAROL);
        mockMemberships([], []);
        const clientCarol = await connect(node.port, CAROL);

        await adapterSync();

        const revokedEvent = waitFor(clientCarol, 'device_revoked');
        const disconnected = new Promise<void>((resolve) =>
          clientCarol.on('disconnect', () => resolve()),
        );

        // Any gateway instance can publish this — here we simulate it directly.
        await redis.publish(`device_revoked:${CAROL.deviceId}`, '1');

        await Promise.all([revokedEvent, disconnected]);

        expect(clientCarol.connected).toBe(false);
      } finally {
        await revSub.quit().catch(() => {});
        await node.close();
      }
    });
  });

  // ── 5. Resume / sync after simulated drop ─────────────────────────────────

  describe('resume/sync after simulated drop', () => {
    it('replays all missed ephemeral events and signals syncRequired on reconnect', async () => {
      const node = await createGatewayNode(BASE_PORT + 6, redis);

      try {
        const { userId } = ALICE;

        // Write two ephemeral events to Alice's resume stream before she connects.
        const id1 = await recordEphemeralEvent(redis, userId, {
          type: 'read_receipt',
          data: { conversationId: CONV_ID, lastReadMessageId: 'msg-old-1' },
        });
        const id2 = await recordEphemeralEvent(redis, userId, {
          type: 'presence_update',
          data: { userId: BOB.userId, online: true },
        });

        expect(id1).toBeTruthy();
        expect(id2).toBeTruthy();

        mockDevice(ALICE);
        mockMemberships([], []);
        const client = await connect(node.port, ALICE);

        const replays: Array<{ id: string; type: string }> = [];
        const firstReplayHandler = (evt: { id: string; type: string }) => replays.push(evt);
        client.on('ephemeral_replay', firstReplayHandler);

        const complete = waitFor<{ lastEventId: string; syncRequired: boolean }>(
          client,
          'resume_complete',
        );

        // Simulate a reconnect with no prior cursor → full replay.
        client.emit('resume', { lastEventId: '' });

        const result = await complete;

        expect(result.syncRequired).toBe(true);
        expect(result.lastEventId).toBe(id2);
        expect(replays).toHaveLength(2);
        expect(replays[0]!.type).toBe('read_receipt');
        expect(replays[1]!.type).toBe('presence_update');

        // Replaying with the advanced cursor must produce no new replays.
        client.off('ephemeral_replay', firstReplayHandler);
        const replays2: unknown[] = [];
        client.on('ephemeral_replay', (evt) => replays2.push(evt));
        const complete2 = waitFor(client, 'resume_complete');
        client.emit('resume', { lastEventId: id2 });

        await complete2;
        expect(replays2).toHaveLength(0);

        client.disconnect();
      } finally {
        await node.close();
      }
    });
  });
});
