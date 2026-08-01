/**
 * Signal-invariant guard for the WebSocket `send_message` / `edit_message`
 * handlers. Unlike the REST send path these parse the raw socket payload by
 * hand rather than through a Zod schema, so `findForbiddenSessionStateField`
 * (lib/signalInvariants.ts) is the enforcement point: any payload carrying
 * session/ratchet/private-key state must be rejected before the handler
 * touches membership checks or the database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockMessagesFindFirst = vi.fn();
const mockMembersFindFirst = vi.fn();
const mockMembersFindMany = vi.fn();
const mockDevicesFindMany = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => {
  const db: Record<string, unknown> = {
    query: {
      conversationMembers: { findFirst: mockMembersFindFirst, findMany: mockMembersFindMany },
      messages: { findFirst: mockMessagesFindFirst },
      devices: { findMany: mockDevicesFindMany },
    },
    insert: mockInsert,
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return { db };
});

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: {},
  messages: {},
  messageEnvelopes: {},
  devices: {},
  files: {},
}));

vi.mock('../lib/conversationCache.js', () => ({
  invalidateConversationCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));

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

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  lt: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ col, vals })),
  or: vi.fn((...args: unknown[]) => args),
}));

function makeSocket(userId: string, deviceId: string) {
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

async function getHandler(eventName: string, socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return socket.listeners(eventName)[0] as (p: unknown) => Promise<void>;
}

const USER_ID = 'sender-1';
const DEVICE_ID = 'device-1';

const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  then: (resolve: (value: unknown) => void) => resolve(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockMembersFindFirst.mockResolvedValue({ conversationId: 'conv-1', userId: USER_ID });
  mockMembersFindMany.mockResolvedValue([]);
  mockDevicesFindMany.mockResolvedValue([]);
  mockMessagesFindFirst.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values: mockValues });
  mockReturning.mockResolvedValue([
    { id: 'msg-1', createdAt: new Date('2024-01-01T00:00:05.000Z') },
  ]);
});

describe('send_message socket event — session/private-key state rejection', () => {
  it('rejects a payload carrying ratchetState before any DB lookup', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler('send_message', socket, makeIo());

    await handler({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      ciphertext: 'hi',
      ratchetState: { rootKey: 'x' },
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'send_message', code: 400 }),
    );
    expect(mockMembersFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a private key nested inside an envelope entry', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler('send_message', socket, makeIo());

    await handler({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      ciphertext: 'hi',
      envelopes: [{ recipientDeviceId: 'device-2', ciphertext: 'x', privateKey: 'secret' }],
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'send_message', code: 400 }),
    );
    expect(mockMembersFindFirst).not.toHaveBeenCalled();
  });

  it('processes a clean payload normally (control case)', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler('send_message', socket, makeIo());

    await handler({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      ciphertext: 'hi',
      envelopes: [{ recipientDeviceId: 'device-2', ciphertext: 'x' }],
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'message_ack',
      expect.objectContaining({ messageId: 'msg-1' }),
    );
    expect(mockMembersFindFirst).toHaveBeenCalled();
  });
});

describe('edit_message socket event — session/private-key state rejection', () => {
  it('rejects a payload carrying sessionState before any DB lookup', async () => {
    const socket = makeSocket(USER_ID, DEVICE_ID);
    const handler = await getHandler('edit_message', socket, makeIo());

    await handler({
      originalMessageId: 'orig',
      messageId: 'new-msg',
      ciphertext: 'hi',
      sessionState: 'opaque-blob',
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ event: 'edit_message', code: 400 }),
    );
    expect(mockMessagesFindFirst).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
