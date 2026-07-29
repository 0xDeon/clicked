/**
 * signalClient.ts — Signal Protocol adapter (web), Phase-2 of the
 * SessionCrypto interface (session.ts).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Multi-device Signal (issue: sessions per sibling device)
 *
 * Every device — a recipient's phone, laptop, and every one of the sending
 * user's *own* sibling devices alike — is its own encryption target with
 * its own independently-established session (signalSession.ts, keyed by
 * device id). `buildEnvelopes` fans a single plaintext out into one
 * ratcheted ciphertext per device; the backend's per-device envelope
 * fan-out (services/deviceDelivery.ts, socket/messaging.ts's sibling-device
 * coverage check) is unchanged — it already expects and validates exactly
 * one `{ recipientDeviceId, ciphertext }` entry per active device.
 *
 * A device with no existing session establishes one on first use via X3DH
 * against its published prekey bundle (`GET
 * /users/:userId/devices/:deviceId/key-bundle`) — this is what makes a
 * newly-added sibling device (or a brand-new contact) "just work" the next
 * time a message is sent, no special-casing required. See
 * `configureSignalClient` below for wiring this up to a live bundle fetch.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This file is loaded via dynamic import (see LibsignalSessionCrypto in
 * session.ts) to keep it out of the initial bundle and avoid SSR issues.
 *
 * Current status: functional X3DH + symmetric-ratchet sessions (see
 * signalSession.ts for the forward-secrecy details and the documented gap
 * vs. full Double Ratchet). Swapping in the real
 * @signalapp/libsignal-client library replaces the encryption internals
 * below; `SignalClient`'s public interface does not change. Library choice
 * & audit status: see docs/signal-integration.md.
 */

import type { DeviceRecord, MessageEnvelope } from './crypto.js';
import { toBase64, type IdentityKeyPair, type PreKeyBundle } from './x3dh.js';
import {
  establishSession,
  hasSession,
  ratchetEncryptStep,
  type InitialMessageHeader,
} from './signalSession.js';

export { hasSession };

export interface SignalProtocolAddress {
  deviceId: string;
  identityPublicKey: string;
}

export interface EncryptedMessage {
  ciphertext: string;
  type: 'PreKeySignalMessage' | 'SignalMessage';
}

/** Wire format for one ratcheted ciphertext, base64-encoded end-to-end. */
interface SignalEnvelopePacket {
  v: 1;
  iv: string;
  ct: string;
  messageNumber: number;
  /** Only present on a session's first message — lets the receiver run X3DH too. */
  header: InitialMessageHeader | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────
//
// `SignalClient` needs the local identity keypair (to run X3DH as
// initiator) and a way to fetch a device's prekey bundle. Both are supplied
// once via `configureSignalClient` (e.g. right after
// getOrCreateDeviceIdentity() during sign-in) rather than threaded through
// every SessionCrypto call — that keeps the SessionCrypto interface
// (session.ts) unchanged regardless of which phase is active.

export type FetchKeyBundle = (userId: string, deviceId: string) => Promise<PreKeyBundle>;

interface SignalClientConfig {
  myIdentity: IdentityKeyPair;
  fetchKeyBundle: FetchKeyBundle;
}

let config: SignalClientConfig | null = null;

export function configureSignalClient(nextConfig: SignalClientConfig): void {
  config = nextConfig;
}

/** Test/sign-out helper — forces the next call to require reconfiguration. */
export function resetSignalClientConfig(): void {
  config = null;
}

async function ensureSession(device: DeviceRecord): Promise<void> {
  if (hasSession(device.id)) return;

  if (!config) {
    throw new Error(
      '[signalClient] Not configured — call configureSignalClient({ myIdentity, fetchKeyBundle }) ' +
        'once during sign-in before sending any Phase-2 encrypted message.',
    );
  }

  const bundle = await config.fetchKeyBundle(device.userId, device.id);
  establishSession(device.id, bundle, config.myIdentity);
}

// ─── AES-GCM message encryption ───────────────────────────────────────────────

async function aesGcmEncrypt(
  messageKey: Uint8Array,
  associatedData: Uint8Array,
  plaintext: string,
): Promise<{ iv: string; ciphertext: string }> {
  const key = await crypto.subtle.importKey('raw', messageKey, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData },
    key,
    plaintextBytes,
  );

  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}

// ─── SignalClient namespace ───────────────────────────────────────────────────

export const SignalClient = {
  /**
   * Encrypt `plaintext` to a single device using its own Signal session
   * (signalSession.ts): establishes one via X3DH on first contact, then
   * advances that device's sending chain by exactly one ratchet step per
   * call — every message to every device gets its own forward-secret key.
   */
  async encryptToDevice(plaintext: string, device: DeviceRecord): Promise<string> {
    await ensureSession(device);
    const step = ratchetEncryptStep(device.id);
    const { iv, ciphertext } = await aesGcmEncrypt(step.messageKey, step.associatedData, plaintext);

    const packet: SignalEnvelopePacket = {
      v: 1,
      iv,
      ct: ciphertext,
      messageNumber: step.messageNumber,
      header: step.initialMessageHeader,
    };
    return toBase64(new TextEncoder().encode(JSON.stringify(packet)));
  },

  /**
   * Encrypt `plaintext` to every device in `devices` — one independent
   * ratcheted ciphertext per device, including the sender's own sibling
   * devices (whichever devices `devices` contains; `session.ts` /
   * crypto.ts's device-set resolution decides membership, this function
   * just fans out over whatever it's given). Devices are encrypted in
   * parallel: each has its own session/chain, so — unlike a single
   * session's chain, which must advance strictly in order — there's no
   * shared mutable state between devices for concurrent calls to race on.
   */
  async buildEnvelopes(plaintext: string, devices: DeviceRecord[]): Promise<MessageEnvelope[]> {
    const envelopes = await Promise.all(
      devices.map(async (device) => {
        const ciphertext = await SignalClient.encryptToDevice(plaintext, device);
        return { recipientDeviceId: device.id, ciphertext };
      }),
    );
    return envelopes;
  },
};
