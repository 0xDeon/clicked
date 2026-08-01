/**
 * Phase-1 → Signal migration enforcement (#364).
 *
 * The product shipped on the Phase-1 sealed box (ECDH + HKDF + AES-256-GCM,
 * one independent box per recipient device). Signal's Double Ratchet replaces
 * it, but not everywhere at once: clients update at their own pace, so a
 * conversation contains devices on both sides of that line for as long as the
 * slowest one takes.
 *
 * *Which* protocol a pair of devices should use is already answered by
 * `selectProtocol` over `devices.capabilities` (lib/capabilities.ts, #180
 * follow-on). This module adds the two things negotiation alone does not give
 * the migration:
 *
 *   1. **Enforcement on the way in.** A sender can claim any protocol it likes
 *      on an envelope. Two claims must be rejected: one the recipient cannot
 *      decrypt, and one weaker than what both sides can actually do.
 *   2. **A record of what was used.** `message_envelopes.protocol` stores the
 *      construction each envelope was built with, so history written before a
 *      pair cut over keeps decrypting on the Phase-1 path forever.
 *
 * Negotiation is deliberately *per device pair*, not per conversation. The
 * envelope model already encrypts once per recipient device, so there is no
 * reason to hold a Signal-capable device back because some other member of the
 * conversation is still on an old client — that device gets Signal today and
 * the laggard keeps sealed box until it upgrades.
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
import {
  BASELINE_PROTOCOL,
  normalizeCapabilities,
  selectProtocol,
  type KnownProtocol,
} from '../lib/capabilities.js';

export type E2eeProtocol = KnownProtocol;

export interface EnvelopeProtocolInput {
  recipientDeviceId: string;
  protocol: E2eeProtocol;
}

export interface ProtocolViolation {
  recipientDeviceId: string;
  /** What the envelope claimed. */
  declared: E2eeProtocol;
  /** What the two devices should have used. */
  expected: E2eeProtocol;
  reason: 'unsupported_by_recipient' | 'downgrade';
}

export type EnvelopeProtocolCheck =
  | { ok: true }
  | { ok: false; code: 400 | 409; error: string; violations: ProtocolViolation[] };

/**
 * Validates the protocol each outgoing envelope claims against what the sender
 * device and each recipient device actually advertise.
 *
 * Two failures are possible, and they are different problems:
 *
 * - **`unsupported_by_recipient` (`400`).** The envelope names a protocol the
 *   recipient does not advertise. It would be undecryptable on arrival, which
 *   the recipient cannot distinguish from tampering — so it is refused at the
 *   door rather than delivered as a message that mysteriously fails to open.
 * - **`downgrade` (`409`).** Both devices can do better than what the envelope
 *   claims. Without this check a patched or compromised client could quietly
 *   keep a peer on the weaker construction forever and nobody would notice.
 *
 * Envelopes naming a device that does not resolve are skipped; the send paths
 * already drop those before persisting.
 */
export async function checkEnvelopeProtocols(
  senderDeviceId: string | undefined,
  envelopes: EnvelopeProtocolInput[],
): Promise<EnvelopeProtocolCheck> {
  if (envelopes.length === 0) return { ok: true };

  const senderDevice = senderDeviceId
    ? await db.query.devices.findFirst({
        where: eq(devices.id, senderDeviceId),
        columns: { capabilities: true },
      })
    : undefined;

  const recipientIds = [...new Set(envelopes.map((e) => e.recipientDeviceId))];
  const recipientRows = await db.query.devices.findMany({
    where: inArray(devices.id, recipientIds),
    columns: { id: true, capabilities: true },
  });
  const capabilitiesByDevice = new Map(recipientRows.map((d) => [d.id, d.capabilities]));

  const violations: ProtocolViolation[] = [];

  for (const envelope of envelopes) {
    if (!capabilitiesByDevice.has(envelope.recipientDeviceId)) continue;

    const recipientCapabilities = capabilitiesByDevice.get(envelope.recipientDeviceId);
    const recipientProtocols = new Set(normalizeCapabilities(recipientCapabilities).protocols);
    const expected = selectProtocol(senderDevice?.capabilities, recipientCapabilities).protocol;

    if (!recipientProtocols.has(envelope.protocol)) {
      violations.push({
        recipientDeviceId: envelope.recipientDeviceId,
        declared: envelope.protocol,
        expected,
        reason: 'unsupported_by_recipient',
      });
      continue;
    }

    if (envelope.protocol !== expected) {
      violations.push({
        recipientDeviceId: envelope.recipientDeviceId,
        declared: envelope.protocol,
        expected,
        reason: 'downgrade',
      });
    }
  }

  if (violations.length === 0) return { ok: true };

  // An undecryptable envelope is the more specific failure, so it decides the
  // status code when a batch contains both kinds.
  const hasUnsupported = violations.some((v) => v.reason === 'unsupported_by_recipient');

  if (hasUnsupported) {
    return {
      ok: false,
      code: 400,
      error: 'Envelope protocol is not supported by the recipient device',
      violations,
    };
  }

  return {
    ok: false,
    code: 409,
    error: 'Envelope protocol is weaker than both devices support',
    violations,
  };
}

/**
 * The protocol a sender device should use with each recipient device. Exposed
 * so callers can answer "what should I use here" with the same rule the send
 * path enforces, rather than re-deriving it.
 *
 * Devices that do not resolve fall back to the universal baseline.
 */
export async function protocolsForRecipients(
  senderDeviceId: string | undefined,
  recipientDeviceIds: string[],
): Promise<Map<string, E2eeProtocol>> {
  const result = new Map<string, E2eeProtocol>();
  if (recipientDeviceIds.length === 0) return result;

  const senderDevice = senderDeviceId
    ? await db.query.devices.findFirst({
        where: eq(devices.id, senderDeviceId),
        columns: { capabilities: true },
      })
    : undefined;

  const rows = await db.query.devices.findMany({
    where: inArray(devices.id, [...new Set(recipientDeviceIds)]),
    columns: { id: true, capabilities: true },
  });

  for (const row of rows) {
    result.set(row.id, selectProtocol(senderDevice?.capabilities, row.capabilities).protocol);
  }

  for (const id of recipientDeviceIds) {
    if (!result.has(id)) result.set(id, BASELINE_PROTOCOL);
  }

  return result;
}
