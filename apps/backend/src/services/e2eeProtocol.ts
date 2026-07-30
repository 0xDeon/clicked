/**
 * Phase-1 → Signal migration (#364).
 *
 * The product shipped on the Phase-1 sealed box (ECDH + HKDF + AES-256-GCM,
 * one independent box per message). Signal's Double Ratchet replaces it, but
 * not everywhere at once: clients update at their own pace, and a conversation
 * contains devices on both sides of that line for as long as the slowest one
 * takes.
 *
 * The rules this module encodes:
 *
 *   1. **History is never re-encrypted.** Old envelopes keep `protocol =
 *      'sealed_box'` and stay decryptable by the Phase-1 path forever. The
 *      cutover changes what is written next, never what was written before.
 *   2. **A conversation cuts over only when every active device on every side
 *      advertises Signal support.** One un-upgraded device holds the whole
 *      conversation on sealed box, because the sender has to produce an
 *      envelope that device can actually open.
 *   3. **After cutover, sealed box is refused.** Otherwise a patched or
 *      compromised client could keep everyone on the weaker construction
 *      indefinitely, and no one would notice.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, devices } from '../db/schema.js';

export type E2eeProtocol = 'sealed_box' | 'signal';

export interface BlockingDevice {
  deviceId: string;
  userId: string;
  deviceName: string | null;
  platform: string | null;
}

export interface ProtocolNegotiation {
  /** What new messages in this conversation must use. */
  protocol: E2eeProtocol;
  totalActiveDevices: number;
  signalCapableDevices: number;
  /** Active devices still on sealed box — what is holding the cutover back. */
  blockingDevices: BlockingDevice[];
}

/** Active devices belonging to every member of a conversation. */
async function activeConversationDevices(conversationId: string) {
  const memberRows = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });

  const userIds = memberRows.map((m) => m.userId);
  if (userIds.length === 0) return [];

  return db.query.devices.findMany({
    where: and(inArray(devices.userId, userIds), isNull(devices.revokedAt)),
    columns: {
      id: true,
      userId: true,
      deviceName: true,
      platform: true,
      supportsSignal: true,
    },
  });
}

/**
 * Resolves which protocol new messages in a conversation must use.
 *
 * A conversation with no active devices reports `sealed_box`: there is nothing
 * to negotiate with, and defaulting an empty set to `signal` would flip the
 * conversation to a mode no device can read the moment one joins.
 */
export async function negotiateConversationProtocol(
  conversationId: string,
): Promise<ProtocolNegotiation> {
  const deviceRows = await activeConversationDevices(conversationId);

  const blockingDevices = deviceRows
    .filter((d) => !d.supportsSignal)
    .map((d) => ({
      deviceId: d.id,
      userId: d.userId,
      deviceName: d.deviceName,
      platform: d.platform,
    }));

  const capable = deviceRows.length - blockingDevices.length;

  return {
    protocol: deviceRows.length > 0 && blockingDevices.length === 0 ? 'signal' : 'sealed_box',
    totalActiveDevices: deviceRows.length,
    signalCapableDevices: capable,
    blockingDevices,
  };
}

export interface EnvelopeProtocolInput {
  recipientDeviceId: string;
  protocol: E2eeProtocol;
}

export type EnvelopeProtocolCheck =
  | { ok: true; negotiated: E2eeProtocol }
  | {
      ok: false;
      code: 400 | 409;
      error: string;
      negotiated: E2eeProtocol;
      offendingDeviceIds: string[];
    };

/**
 * Validates the protocol each outgoing envelope claims.
 *
 * Two failures are possible, and they are different problems:
 *
 * - **`signal` to a device that cannot read it** (`400`). The sender got ahead
 *   of the recipient. That envelope would be undecryptable on arrival, which
 *   the recipient cannot distinguish from tampering.
 * - **`sealed_box` after the conversation has cut over** (`409`). Everyone can
 *   do Signal, so falling back is a downgrade. The sender is told the
 *   negotiated protocol and re-sends.
 *
 * Both surface the offending device ids so the client can re-fetch the device
 * set and rebuild rather than retrying blind.
 */
export async function checkEnvelopeProtocols(
  conversationId: string,
  envelopes: EnvelopeProtocolInput[],
): Promise<EnvelopeProtocolCheck> {
  const negotiation = await negotiateConversationProtocol(conversationId);
  const negotiated = negotiation.protocol;

  const signalEnvelopes = envelopes.filter((e) => e.protocol === 'signal');

  if (signalEnvelopes.length > 0) {
    const incapable = new Set(negotiation.blockingDevices.map((d) => d.deviceId));
    const offending = signalEnvelopes
      .filter((e) => incapable.has(e.recipientDeviceId))
      .map((e) => e.recipientDeviceId);

    if (offending.length > 0) {
      return {
        ok: false,
        code: 400,
        error: 'Signal envelope addressed to a device that does not support Signal',
        negotiated,
        offendingDeviceIds: offending,
      };
    }
  }

  if (negotiated === 'signal') {
    const downgraded = envelopes
      .filter((e) => e.protocol === 'sealed_box')
      .map((e) => e.recipientDeviceId);

    if (downgraded.length > 0) {
      return {
        ok: false,
        code: 409,
        error:
          'This conversation has cut over to Signal; sealed-box envelopes are no longer accepted',
        negotiated,
        offendingDeviceIds: downgraded,
      };
    }
  }

  return { ok: true, negotiated };
}
