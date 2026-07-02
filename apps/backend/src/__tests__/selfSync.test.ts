/**
 * Multi-device self-sync — issue #188
 *
 * When a user sends (or edits) a message, the server must verify that every
 * active sibling device the sender owns is covered by an envelope in the
 * payload.  If any sibling is absent the server emits `device_set_mismatch`
 * and aborts, so no sibling device is ever silently left out.
 *
 * Acceptance criteria exercised here:
 *   1. Sibling devices receive their own envelopes (fan-out path still works)
 *   2. Server rejects a payload missing sibling envelopes (device_set_mismatch)
 *   3. A freshly linked device causes subsequent messages to fail until its
 *      envelope is included (verified by changing the sibling list between calls)
 *   4. Revoked sibling devices are NOT required in envelopes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockUserDevicesFindMany = vi.fn();
const mockMemberFindMany = vi.fn();

const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({
  returning: mockReturning,
  then: (resolve: (v: unknown) => void) => resolve(undefined),
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));

// db.select chain used by deliveryPipeline.ts inside deliverMessage.
// First call: members query → non-empty so deliverMessage doesn't early-return.
// Second call: activeDevices query → empty so deliverMessage emits new_message.
const mockSelectWhere = vi.fn();
const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: {
        findFirst: mockMemberFindFirst,
        findMany: mockMemberFindMany,
      },
      messages: { findFirst: mockMessageFindFirst },
      userDevices: { findMany: mockUserDevicesFindMany },
    },
    insert: mockInsert,
    update: vi.fn(),
    delete: vi.fn(),
    select: mockSelect,
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

vi.mock('../lib/redis.js', () => ({ redis: null }));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/validateMessagePayload.js', () => ({
  validateMessagePayload: vi.fn().mockReturnValue({ ok: true }),
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
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSocket(userId: string, deviceId = 'device-sender') {
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

async function getHandlers(socket: EventEmitter, io: unknown) {
  const { registerMessagingHandlers } = await import('../socket/messaging.js');
  registerMessagingHandlers(io as never, socket as never);
  return {
    sendMessage: socket.listeners('send_message')[0] as (p: unknown) => Promise<void>,
    editMessage: socket.listeners('edit_message')[0] as (p: unknown) => Promise<void>,
  };
}

// ── shared constants ──────────────────────────────────────────────────────────

const USER_ID = 'user-alice';
const SENDER_DEVICE = 'device-sender';
const SIBLING_B = 'device-sibling-b';
const SIBLING_C = 'device-sibling-c';
const CONV_ID = 'conv-1';

const MEMBERSHIP = { id: 'm1', userId: USER_ID, conversationId: CONV_ID };
const BASE_MESSAGE = {
  id: 'orig-msg',
  conversationId: CONV_ID,
  senderId: USER_ID,
  senderDeviceId: SENDER_DEVICE,
  contentType: 'text/plain',
  editsMessageId: null,
  ciphertext: 'abc',
  sequenceNumber: 1,
};

beforeEach(() => {
  // mockReset() clears both call history AND any unconsumed mockResolvedValueOnce queue
  // entries. Use it for all query mocks to prevent stale queue values from bleeding
  // between tests. (vi.clearAllMocks() only clears call history, not the queue.)
  mockMemberFindFirst.mockReset().mockResolvedValue(MEMBERSHIP);
  mockMessageFindFirst.mockReset().mockResolvedValue(undefined);
  mockMemberFindMany.mockReset().mockResolvedValue([]);
  mockUserDevicesFindMany.mockReset().mockResolvedValue([]);
  mockReturning
    .mockReset()
    .mockResolvedValue([{ ...BASE_MESSAGE, id: 'new-msg', sequenceNumber: 2 }]);

  // Only clear call history for structural vi.fn(impl) mocks — mockReset would
  // wipe their implementations and break the insert().values().returning() chain.
  mockInsert.mockClear();
  mockValues.mockClear();
  mockSelect.mockClear();
  mockSelectFrom.mockClear();
  // deliverMessage (deliveryPipeline.ts) calls db.select twice:
  //   1st: members query → must be non-empty so it doesn't early-return
  //   2nd: activeDevices query → empty triggers io.to().emit('new_message')
  mockSelectWhere
    .mockReset()
    .mockResolvedValueOnce([{ userId: USER_ID }])
    .mockResolvedValue([]);
});

// ── send_message ──────────────────────────────────────────────────────────────

describe('send_message — sibling device enforcement (#188)', () => {
  it('accepts a message when the sender has no sibling devices', async () => {
    mockUserDevicesFindMany.mockResolvedValue([]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    await sendMessage({ conversationId: CONV_ID, messageId: 'msg-1', ciphertext: 'hello' });

    expect(mockInsert).toHaveBeenCalled();
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    expect(io.roomEmitted.some((e) => e.event === 'new_message')).toBe(true);
  });

  it('accepts a message that includes envelopes for all active siblings', async () => {
    mockUserDevicesFindMany
      // fetchSiblingDeviceIds call → returns sibling B
      .mockResolvedValueOnce([{ id: SIBLING_B }])
      // envelope fan-out validation call → returns device info for both recipients
      .mockResolvedValueOnce([
        { id: SIBLING_B, userId: USER_ID },
        { id: 'device-bob', userId: 'user-bob' },
      ]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    await sendMessage({
      conversationId: CONV_ID,
      messageId: 'msg-2',
      ciphertext: 'group-cipher',
      envelopes: [
        { recipientDeviceId: SIBLING_B, ciphertext: 'for-sibling-b' },
        { recipientDeviceId: 'device-bob', ciphertext: 'for-bob' },
      ],
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    expect(io.roomEmitted.some((e) => e.event === 'new_message')).toBe(true);
  });

  it('rejects with device_set_mismatch when a sibling device is omitted', async () => {
    mockUserDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }, { id: SIBLING_C }]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    // Only include sibling-B; sibling-C is absent.
    await sendMessage({
      conversationId: CONV_ID,
      messageId: 'msg-3',
      ciphertext: 'partial',
      envelopes: [{ recipientDeviceId: SIBLING_B, ciphertext: 'for-b' }],
    });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect((errors[0]!.data as { missingDeviceIds: string[] }).missingDeviceIds).toContain(
      SIBLING_C,
    );
    expect(mockInsert).not.toHaveBeenCalled();
    expect(io.roomEmitted.some((e) => e.event === 'new_message')).toBe(false);
  });

  it('rejects with device_set_mismatch when envelopes are absent but siblings exist', async () => {
    mockUserDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    // No envelopes field at all — only ciphertext provided.
    await sendMessage({ conversationId: CONV_ID, messageId: 'msg-4', ciphertext: 'plain' });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does not require envelopes for revoked sibling devices', async () => {
    // fetchSiblingDeviceIds only returns non-revoked → empty because the
    // revokedAt filter excludes the revoked device at the DB level.
    mockUserDevicesFindMany.mockResolvedValueOnce([]); // no active siblings

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    await sendMessage({ conversationId: CONV_ID, messageId: 'msg-5', ciphertext: 'ok' });

    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('still passes through the idempotency ack without a device set check', async () => {
    // Idempotency fires BEFORE the sibling check — a duplicate messageId returns
    // ack immediately, no re-validation of envelopes needed.
    mockMessageFindFirst.mockResolvedValue({ sequenceNumber: 7 });

    // Even with a sibling that would normally require an envelope…
    mockUserDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    await sendMessage({ conversationId: CONV_ID, messageId: 'dup-msg', ciphertext: 'x' });

    expect(socket.emit).toHaveBeenCalledWith('message_ack', {
      messageId: 'dup-msg',
      sequenceNumber: 7,
    });
    // Sibling check never runs — insert should not be called.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('freshly linked sibling causes subsequent sends to fail without its envelope', async () => {
    // First send: no siblings → succeeds.
    mockUserDevicesFindMany.mockResolvedValueOnce([]);
    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { sendMessage } = await getHandlers(socket, io);

    await sendMessage({ conversationId: CONV_ID, messageId: 'msg-first', ciphertext: 'ok' });
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);

    vi.clearAllMocks();
    mockMemberFindFirst.mockResolvedValue(MEMBERSHIP);
    mockMessageFindFirst.mockResolvedValue(undefined);
    mockMemberFindMany.mockResolvedValue([]);
    mockReturning.mockResolvedValue([{ ...BASE_MESSAGE, id: 'msg-second', sequenceNumber: 3 }]);

    // Second send: sibling-B just linked → now appears in DB query → must be included.
    mockUserDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }]);

    await sendMessage({ conversationId: CONV_ID, messageId: 'msg-second', ciphertext: 'ok' });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors[0]!).toBeDefined();
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── edit_message ──────────────────────────────────────────────────────────────

describe('edit_message — sibling device enforcement (#188)', () => {
  const ORIGINAL = {
    id: 'orig-msg',
    senderId: USER_ID,
    conversationId: CONV_ID,
    editsMessageId: null,
    contentType: 'text/plain',
  };

  // Each edit test sets up its own mockMessageFindFirst chain so the
  // outer beforeEach reset cannot interfere with the queued values.

  it('accepts an edit that includes envelopes for all active siblings', async () => {
    mockMessageFindFirst
      .mockResolvedValueOnce(ORIGINAL) // original message lookup
      .mockResolvedValueOnce(undefined); // idempotency check
    mockUserDevicesFindMany
      .mockResolvedValueOnce([{ id: SIBLING_B }]) // fetchSiblingDeviceIds
      .mockResolvedValueOnce([{ id: SIBLING_B, userId: USER_ID }]); // envelope fanout

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { editMessage } = await getHandlers(socket, io);

    await editMessage({
      originalMessageId: 'orig-msg',
      messageId: 'edit-1',
      ciphertext: 'updated',
      envelopes: [{ recipientDeviceId: SIBLING_B, ciphertext: 'for-sibling-b' }],
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
    const events = io.roomEmitted.map((e) => e.event);
    expect(events).toContain('new_message');
    expect(events).toContain('message_edited');
  });

  it('rejects an edit with device_set_mismatch when a sibling is missing', async () => {
    mockMessageFindFirst.mockResolvedValueOnce(ORIGINAL).mockResolvedValueOnce(undefined);
    mockUserDevicesFindMany.mockResolvedValueOnce([{ id: SIBLING_B }, { id: SIBLING_C }]);

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { editMessage } = await getHandlers(socket, io);

    await editMessage({
      originalMessageId: 'orig-msg',
      messageId: 'edit-2',
      ciphertext: 'updated',
      envelopes: [{ recipientDeviceId: SIBLING_B, ciphertext: 'only-b' }],
    });

    const errors = socket.emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { event: string }).event).toBe('device_set_mismatch');
    expect((errors[0]!.data as { missingDeviceIds: string[] }).missingDeviceIds).toContain(
      SIBLING_C,
    );
    expect(mockInsert).not.toHaveBeenCalled();
    expect(io.roomEmitted.some((e) => e.event === 'message_edited')).toBe(false);
  });

  it('accepts an edit when the sender has no sibling devices', async () => {
    mockMessageFindFirst.mockResolvedValueOnce(ORIGINAL).mockResolvedValueOnce(undefined);
    mockUserDevicesFindMany.mockResolvedValueOnce([]); // no siblings

    const socket = makeSocket(USER_ID, SENDER_DEVICE);
    const io = makeIo();
    const { editMessage } = await getHandlers(socket, io);

    await editMessage({
      originalMessageId: 'orig-msg',
      messageId: 'edit-3',
      ciphertext: 'solo-edit',
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(socket.emitted.some((e) => e.event === 'error')).toBe(false);
  });
});
