// #183 — fan-out service: resolve members -> devices -> envelopes
//
// Given an unpersisted message and a sender-provided map of
// { recipientDeviceId -> ciphertext }, validates that the client encrypted
// to exactly the conversation's current active recipient devices (including
// the sender's *other* devices, for multi-device self-sync — but excluding
// the device that is doing the sending). If the client's device set is stale,
// returns device_set_mismatch with the authoritative device list instead of
// guessing or dropping ciphertext. On success, the message and its envelopes
// are persisted atomically.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageEnvelopes, devices } from '../db/schema.js';
import type { Message, NewMessage } from '../db/schema.js';
import { messagesPersistedTotal, envelopeInsertDuration } from '../lib/metrics.js';

export interface FanoutSuccess {
  ok: true;
  message: Message;
}

export interface FanoutDeviceSetMismatch {
  ok: false;
  error: 'device_set_mismatch';
  expectedDeviceIds: string[];
}

export type FanoutResult = FanoutSuccess | FanoutDeviceSetMismatch;

interface RecipientDeviceSet {
  expectedDeviceIds: string[];
  deviceToUser: Map<string, string>;
}

/**
 * Resolves the authoritative active recipient-device set for a conversation.
 *
 * Every conversation member contributes all of their active devices. The
 * device sending the message is excluded because it does not need an
 * envelope; all of the sender's other active devices remain recipients for
 * multi-device self-sync.
 */
export async function resolveRecipientDeviceSet(
  conversationId: string,
  senderDeviceId: string | null,
): Promise<string[]> {
  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });
  const memberIds = members.map((member) => member.userId);

  if (memberIds.length === 0) return [];

  const activeDevices = await db.query.devices.findMany({
    where: and(inArray(devices.userId, memberIds), isNull(devices.revokedAt)),
    columns: { id: true },
  });

  return activeDevices.filter((device) => device.id !== senderDeviceId).map((device) => device.id);
}

async function resolveRecipientDevices(
  conversationId: string,
  senderDeviceId: string | null,
): Promise<RecipientDeviceSet> {
  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });
  const memberIds = members.map((member) => member.userId);

  if (memberIds.length === 0) {
    return { expectedDeviceIds: [], deviceToUser: new Map() };
  }

  const activeDevices = await db.query.devices.findMany({
    where: and(inArray(devices.userId, memberIds), isNull(devices.revokedAt)),
    columns: { id: true, userId: true },
  });

  const expectedDevices = activeDevices.filter((device) => device.id !== senderDeviceId);
  return {
    expectedDeviceIds: expectedDevices.map((device) => device.id),
    deviceToUser: new Map(expectedDevices.map((device) => [device.id, device.userId])),
  };
}

/**
 * Persists `newMessage` and its per-device envelopes in a single transaction,
 * after verifying `envelopeCiphertexts` covers exactly the conversation's
 * current active recipient devices.
 *
 * @param newMessage - Message row to insert (id may be omitted; defaultRandom).
 * @param senderDeviceId - The device sending this message; excluded from the
 *   authoritative recipient set (it doesn't need its own envelope).
 * @param envelopeCiphertexts - Sender-provided map of recipientDeviceId -> ciphertext.
 */
export async function fanoutMessage(
  newMessage: NewMessage,
  senderDeviceId: string | null,
  envelopeCiphertexts: Record<string, string>,
): Promise<FanoutResult> {
  const { expectedDeviceIds, deviceToUser } = await resolveRecipientDevices(
    newMessage.conversationId,
    senderDeviceId,
  );
  const expectedDeviceIdSet = new Set(expectedDeviceIds);
  const providedDeviceIds = Object.keys(envelopeCiphertexts);
  const setsMatch =
    providedDeviceIds.length === expectedDeviceIdSet.size &&
    providedDeviceIds.every((deviceId) => expectedDeviceIdSet.has(deviceId));

  if (!setsMatch) {
    return {
      ok: false,
      error: 'device_set_mismatch',
      expectedDeviceIds,
    };
  }

  const message = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(messages).values(newMessage).returning();
    const persisted = inserted!;

    const envelopeRows = providedDeviceIds.map((deviceId) => ({
      messageId: persisted.id,
      recipientDeviceId: deviceId,
      recipientUserId: deviceToUser.get(deviceId)!,
      ciphertext: envelopeCiphertexts[deviceId]!,
    }));

    if (envelopeRows.length > 0) {
      const envelopeInsertStart = process.hrtime.bigint();
      await tx.insert(messageEnvelopes).values(envelopeRows);
      envelopeInsertDuration.observe(Number(process.hrtime.bigint() - envelopeInsertStart) / 1e9);
    }

    return persisted;
  });

  messagesPersistedTotal.inc({ contentType: newMessage.contentType ?? 'text' });

  return { ok: true, message };
}

// ─── Group MLS fan-out (#370) ──────────────────────────────────────────────────
//
// For group conversations using MLS the sender produces a single ciphertext
// (encrypted to the MLS group key) rather than one envelope per recipient
// device.  The server stores that ciphertext in `messages.ciphertext` and
// delivers the same row to every active member device via their socket room.
// No `messageEnvelopes` rows are created — MLS epoch keys handle per-device
// decryption client-side.

export interface GroupMlsFanoutSuccess {
  ok: true;
  message: Message;
}

export interface GroupMlsFanoutNotMember {
  ok: false;
  error: 'not_member';
}

export type GroupMlsFanoutResult = GroupMlsFanoutSuccess | GroupMlsFanoutNotMember;

/**
 * Persists a group MLS message and returns it for socket broadcast.
 *
 * @param newMessage - Message row to insert; `ciphertext` must be the MLS
 *   group ciphertext (non-null). No per-device envelopes are inserted.
 * @param senderId - The user sending; must be a current conversation member.
 */
export async function fanoutGroupMlsMessage(
  newMessage: NewMessage,
  senderId: string,
): Promise<GroupMlsFanoutResult> {
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, newMessage.conversationId),
      eq(conversationMembers.userId, senderId),
    ),
    columns: { id: true },
  });

  if (!membership) {
    return { ok: false, error: 'not_member' };
  }

  const [message] = await db.insert(messages).values(newMessage).returning();

  return { ok: true, message: message! };
}
