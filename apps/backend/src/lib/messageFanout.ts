/**
 * Shared per-device envelope fan-out helpers (issues #188, #337).
 *
 * Every path that persists a message row — `send_message`, `edit_message`,
 * `send_file_message` and the server-authored `ask_assistant` reply — must
 * produce one `message_envelopes` row per recipient device inside the same
 * transaction as the message insert. These helpers are the single
 * implementation of that fan-out so the paths cannot drift apart.
 */

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';

import { db } from '../db/index.js';
import { devices, messageEnvelopes } from '../db/schema.js';
import { BASELINE_PROTOCOL, type KnownProtocol } from './capabilities.js';

/** A client-supplied (or server-derived) envelope destined for one device. */
export interface EnvelopeInput {
  recipientDeviceId: string;
  ciphertext: string;
  /**
   * Which construction produced `ciphertext` (#364). Omitted means the
   * Phase-1 sealed box — the protocol every device in this codebase already
   * implements, and what a client that predates the migration sends.
   */
  protocol?: KnownProtocol;
}

/**
 * A Drizzle transaction handle, as handed to the `db.transaction()` callback.
 * `db` itself is also accepted so callers without a transaction (tests, or a
 * single-statement path) can reuse the same fan-out code.
 */
export type EnvelopeTx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Returns the UUIDs of all active (non-revoked) devices that belong to
 * `userId` but are NOT the sending device (`senderDeviceId`). These are the
 * "sibling" devices that must each receive their own envelope so they can
 * decrypt the message locally. Issue #188.
 */
export async function fetchSiblingDeviceIds(
  userId: string,
  senderDeviceId: string,
): Promise<string[]> {
  const siblings = await db.query.devices.findMany({
    where: and(
      eq(devices.userId, userId),
      ne(devices.id, senderDeviceId),
      isNull(devices.revokedAt),
    ),
    columns: { id: true },
  });
  return siblings.map((d) => d.id);
}

/**
 * Sibling-device coverage check (#188). Returns the sibling device ids the
 * caller failed to provide an envelope for; an empty array means the payload
 * is complete and the send may proceed.
 */
export async function findMissingSiblingDeviceIds(
  userId: string,
  senderDeviceId: string,
  envelopes: EnvelopeInput[] | undefined,
): Promise<string[]> {
  const siblingIds = await fetchSiblingDeviceIds(userId, senderDeviceId);
  if (siblingIds.length === 0) return [];

  const providedIds = new Set(envelopes?.map((e) => e.recipientDeviceId) ?? []);
  return siblingIds.filter((id) => !providedIds.has(id));
}

/**
 * Resolves each envelope's device to its owning user and bulk-inserts the
 * rows into `message_envelopes`. Envelopes naming an unknown device id are
 * dropped (the device was hard-deleted between client fan-out and send).
 *
 * MUST be called with the same `tx` used to insert the message row so a
 * message can never be committed without its envelopes.
 *
 * @returns the device ids that actually received an envelope row.
 */
export async function insertMessageEnvelopes(
  tx: EnvelopeTx,
  messageId: string,
  envelopes: EnvelopeInput[] | undefined,
): Promise<string[]> {
  if (!envelopes || envelopes.length === 0) return [];

  const deviceIds = envelopes.map((e) => e.recipientDeviceId);
  const devicesList = await tx.query.devices.findMany({
    where: inArray(devices.id, deviceIds),
    columns: { id: true, userId: true },
  });
  const deviceToUser = new Map(devicesList.map((d) => [d.id, d.userId]));

  const validEnvelopes = envelopes
    .filter((env) => deviceToUser.has(env.recipientDeviceId))
    .map((env) => ({
      messageId,
      recipientDeviceId: env.recipientDeviceId,
      recipientUserId: deviceToUser.get(env.recipientDeviceId)!,
      ciphertext: env.ciphertext,
      // Recorded per envelope so pre-cutover history stays interpretable
      // after a device's capabilities change (#364).
      protocol: env.protocol ?? BASELINE_PROTOCOL,
    }));

  if (validEnvelopes.length === 0) return [];

  await tx.insert(messageEnvelopes).values(validEnvelopes);
  return validEnvelopes.map((e) => e.recipientDeviceId);
}

/**
 * Builds one envelope per active (non-revoked) device owned by `memberUserIds`,
 * all carrying the same `ciphertext`.
 *
 * Used by server-authored messages (the `ask_assistant` reply, #337) where no
 * per-recipient key material exists to encrypt with: the content is identical
 * for every device, but the fan-out *shape* stays consistent with every other
 * message type instead of a bare shared `messages.ciphertext` column.
 *
 * Mirrors the device resolution `deliverMessage` performs
 * (`inArray(devices.userId, …), isNull(devices.revokedAt)`), so the envelope
 * set matches the set of devices delivery will actually target. Pseudo-users
 * such as the assistant own no device rows and are therefore excluded by the
 * query itself rather than by a special case.
 */
export async function buildBroadcastEnvelopes(
  memberUserIds: string[],
  ciphertext: string,
): Promise<EnvelopeInput[]> {
  const userIds = Array.from(new Set(memberUserIds));
  if (userIds.length === 0) return [];

  const activeDevices = await db.query.devices.findMany({
    where: and(inArray(devices.userId, userIds), isNull(devices.revokedAt)),
    columns: { id: true },
  });

  return activeDevices.map((d) => ({ recipientDeviceId: d.id, ciphertext }));
}
