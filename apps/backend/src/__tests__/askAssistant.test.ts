/**
 * ask_assistant — per-device envelope fan-out (#337).
 *
 * The AI-reply insert used to write a single shared `messages.ciphertext` with
 * zero `message_envelopes` rows and broadcast it with a raw
 * `io.to(conversationId).volatile.emit('new_message', …)`.
 *
 * It now produces one envelope per active device of every conversation member
 * and delivers through the standard `deliverMessage` pipeline. A server-authored
 * reply has no per-recipient key material, so every envelope carries the same
 * content — the point of the migration is that the fan-out *shape* matches every
 * other message type, not that the reply becomes E2EE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import { messages as messagesTable, messageEnvelopes } from '../db/schema.js';
import { deliverMessage } from '../services/deliveryPipeline.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockExecute = vi.fn();

const insertCalls: { table: unknown; values: unknown }[] = [];
const mockReturning = vi.fn();
const mockInsert = vi.fn((table: unknown) => ({
  values: (rows: unknown) => {
    insertCalls.push({ table, values: rows });
    return {
      returning: mockReturning,
      then: (resolve: (value: unknown) => void) => resolve(undefined),
    };
  },
}));

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      messages: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
      devices: { findMany: mockDevicesFindMany },
    },
    insert: mockInsert,
    update: vi.fn(),
    delete: vi.fn(),
    execute: mockExecute,
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return { db };
});

vi.mock('../db/schema.js', () => ({
  conversationMembers: { __table: 'conversation_members' },
  conversations: { __table: 'conversations' },
  messages: { __table: 'messages' },
  messageEnvelopes: { __table: 'message_envelopes' },
  devices: { __table: 'devices' },
  files: { __table: 'files' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals, op: 'inArray' })),
  lt: vi.fn(),
  desc: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(() => ({})),
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn(
    async (
      io: { to: (r: string) => { emit: (e: string, d: unknown) => void } },
      message: unknown,
      conversationId: string,
    ) => {
      io.to(conversationId).emit('new_message', message);
    },
  ),
}));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/push.js', () => ({
  sendPushForMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId = ALICE_DEVICE_1) {
  const emitter = new EventEmitter();
  const emitted: { event: string; data: unknown }[] = [];
  return Object.assign(emitter, {
    auth: { userId, deviceId },
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
    }),
    join: vi.fn(),
    emitted,
  });
}

function makeIo() {
  const roomEmitted: { event: string; data: unknown }[] = [];
  const emitFn = vi.fn((event: string, data: unknown) => {
    roomEmitted.push({ event, data });
  });
  return {
    to: vi.fn(() => ({ emit: emitFn, volatile: { emit: emitFn } })),
    roomEmitted,
  };
}

async function getHandler(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return socket.listeners('ask_assistant')[0] as (p: unknown) => Promise<void>;
}

function envelopeRows(): Array<Record<string, unknown>> {
  const call = insertCalls.find((c) => c.table === messageEnvelopes);
  return (call?.values as Array<Record<string, unknown>>) ?? [];
}

function messageRow(): Record<string, unknown> {
  const call = insertCalls.find((c) => c.table === messagesTable);
  return (call?.values as Record<string, unknown>) ?? {};
}

const ASSISTANT_USER_ID = '00000000-0000-4000-8000-000000000000';
const ALICE = 'user-alice';
const ALICE_DEVICE_1 = 'device-alice-1';
const ALICE_DEVICE_2 = 'device-alice-2';
const BOB = 'user-bob';
const BOB_DEVICE = 'device-bob';
const CONVERSATION_ID = 'conv-1';
const REPLY = 'Sure — here is the answer.';
const REPLY_MESSAGE = {
  id: 'assistant-msg-1',
  conversationId: CONVERSATION_ID,
  senderId: ASSISTANT_USER_ID,
  senderDeviceId: null,
  contentType: 'text',
  ciphertext: REPLY,
  createdAt: new Date('2024-01-01T00:00:01.000Z'),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;

  mockMemberFindFirst.mockReset().mockResolvedValue({
    id: 'm1',
    userId: ALICE,
    conversationId: CONVERSATION_ID,
  });
  // Members include the assistant pseudo-user, which owns no device rows.
  mockMemberFindMany
    .mockReset()
    .mockResolvedValue([{ userId: ALICE }, { userId: BOB }, { userId: ASSISTANT_USER_ID }]);
  mockDevicesFindMany
    .mockReset()
    .mockResolvedValue([{ id: ALICE_DEVICE_1 }, { id: ALICE_DEVICE_2 }, { id: BOB_DEVICE }]);
  mockExecute.mockReset().mockResolvedValue(undefined);
  mockReturning.mockReset().mockResolvedValue([REPLY_MESSAGE]);

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reply: REPLY }),
    }),
  );
});

describe('ask_assistant — per-device envelope fan-out (#337)', () => {
  it('inserts one envelope per active device of every conversation member', async () => {
    // Device→user resolution inside the fan-out helper.
    mockDevicesFindMany
      .mockResolvedValueOnce([{ id: ALICE_DEVICE_1 }, { id: ALICE_DEVICE_2 }, { id: BOB_DEVICE }])
      .mockResolvedValueOnce([
        { id: ALICE_DEVICE_1, userId: ALICE },
        { id: ALICE_DEVICE_2, userId: ALICE },
        { id: BOB_DEVICE, userId: BOB },
      ]);

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant what is up?' });

    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);

    expect(messageRow()).toMatchObject({
      conversationId: CONVERSATION_ID,
      senderId: ASSISTANT_USER_ID,
      contentType: 'text',
      ciphertext: REPLY,
    });

    // Every active device of every member gets its own row — including both of
    // the asking user's own devices, so the reply reaches all of them.
    expect(envelopeRows()).toEqual([
      {
        messageId: REPLY_MESSAGE.id,
        recipientDeviceId: ALICE_DEVICE_1,
        recipientUserId: ALICE,
        ciphertext: REPLY,
      },
      {
        messageId: REPLY_MESSAGE.id,
        recipientDeviceId: ALICE_DEVICE_2,
        recipientUserId: ALICE,
        ciphertext: REPLY,
      },
      {
        messageId: REPLY_MESSAGE.id,
        recipientDeviceId: BOB_DEVICE,
        recipientUserId: BOB,
        ciphertext: REPLY,
      },
    ]);
  });

  it('inserts the message and its envelopes in the same transaction', async () => {
    mockDevicesFindMany
      .mockResolvedValueOnce([{ id: BOB_DEVICE }])
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: BOB }]);

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hi' });

    const { db } = (await import('../db/index.js')) as unknown as {
      db: { transaction: ReturnType<typeof vi.fn> };
    };
    expect(db.transaction).toHaveBeenCalledTimes(1);

    // Both the message row and the envelope rows were written by the tx handle.
    expect(insertCalls.map((c) => c.table)).toEqual([messagesTable, messageEnvelopes]);
  });

  it('excludes the assistant pseudo-user, which owns no devices', async () => {
    mockDevicesFindMany
      .mockResolvedValueOnce([{ id: BOB_DEVICE }])
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: BOB }]);

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hello' });

    // The assistant is in the member list passed to the device query, but owns
    // no device rows, so no envelope is addressed to it.
    const { inArray } = (await import('drizzle-orm')) as unknown as {
      inArray: ReturnType<typeof vi.fn>;
    };
    const memberIdsQueried = (inArray.mock.calls[0] as unknown[])[1] as string[];
    expect(memberIdsQueried).toContain(ASSISTANT_USER_ID);

    expect(envelopeRows().some((row) => row.recipientUserId === ASSISTANT_USER_ID)).toBe(false);
  });

  it('writes no envelopes when the conversation has no active devices', async () => {
    mockDevicesFindMany.mockResolvedValue([]);

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hello' });

    expect(envelopeRows()).toHaveLength(0);
    expect(insertCalls.map((c) => c.table)).toEqual([messagesTable]);
    // The message itself is still persisted and delivered.
    expect(deliverMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers through deliverMessage instead of a raw volatile room emit', async () => {
    mockDevicesFindMany
      .mockResolvedValueOnce([{ id: BOB_DEVICE }])
      .mockResolvedValueOnce([{ id: BOB_DEVICE, userId: BOB }]);

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hi' });

    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(deliverMessage).toHaveBeenCalledWith(io, REPLY_MESSAGE, CONVERSATION_ID);
    expect(io.roomEmitted.filter((e) => e.event === 'new_message')).toHaveLength(1);
  });

  it('invalidates conversation caches for every member', async () => {
    const { invalidateConversationCaches } = await import('../lib/conversationCache.js');

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hi' });

    expect(invalidateConversationCaches).toHaveBeenCalledWith([ALICE, BOB, ASSISTANT_USER_ID]);
  });

  it('ignores content that is not addressed to @assistant', async () => {
    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: 'just a normal message' });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it('rejects a non-member before contacting the AI agent', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    const socket = makeSocket('user-intruder');
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant secrets please' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        event: 'ask_assistant',
        message: expect.stringContaining('member'),
      }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('emits an error and writes nothing when the AI agent fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    const socket = makeSocket(ALICE);
    const io = makeIo();
    const handler = await getHandler(socket, io);

    await handler({ conversationId: CONVERSATION_ID, content: '@assistant hi' });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'ask_assistant' }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
    expect(deliverMessage).not.toHaveBeenCalled();
  });
});
