// #183 — fan-out service: resolve members -> devices -> envelopes
//
// Given an unpersisted message and a sender-provided map of
// { recipientDeviceId -> ciphertext }, validates that the client encrypted
// to exactly the conversation's current active recipient devices (including
// the sender's *other* devices, for multi-device self-sync — but excluding
// the device that is doing the sending). If the client's device set is
// stale, returns device_set_mismatch with the authoritative device list
// instead of guessing or dropping ciphertext. On success, the message and
// its envelopes are persisted atomically.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageEnvelopes, userDevices } from '../db/schema.js';
import type { Message, NewMessage } from '../db/schema.js';

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
  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, newMessage.conversationId),
    columns: { userId: true },
  });
  const memberIds = members.map((m) => m.userId);

  const activeDevices = await db.query.userDevices.findMany({
    where: and(inArray(userDevices.userId, memberIds), isNull(userDevices.revokedAt)),
    columns: { id: true, userId: true },
  });

  const expectedDevices = activeDevices.filter((d) => d.id !== senderDeviceId);
  const deviceToUser = new Map(expectedDevices.map((d) => [d.id, d.userId]));
  const expectedDeviceIds = new Set(deviceToUser.keys());

  const providedDeviceIds = Object.keys(envelopeCiphertexts);
  const setsMatch =
    providedDeviceIds.length === expectedDeviceIds.size &&
    providedDeviceIds.every((id) => expectedDeviceIds.has(id));

  if (!setsMatch) {
    return {
      ok: false,
      error: 'device_set_mismatch',
      expectedDeviceIds: [...expectedDeviceIds],
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
      await tx.insert(messageEnvelopes).values(envelopeRows);
    }

    return persisted;
  });

  return { ok: true, message };
}
