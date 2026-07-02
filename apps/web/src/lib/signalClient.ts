/**
 * signalClient.ts — @signalapp/libsignal-client adapter (web)
 *
 * This module wraps the Signal Protocol WASM library behind the
 * SessionCrypto interface defined in session.ts.
 *
 * It is loaded via dynamic import (see LibsignalSessionCrypto) to:
 *   a) Avoid increasing the initial bundle size
 *   b) Prevent server-side WASM initialisation errors in Next.js
 *
 * Library choice & audit status: see docs/signal-integration.md
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Current status: STUB — Phase-2 wiring.
 *
 * This file is intentionally left as a typed stub so:
 *   1. The TypeScript compiler validates the interface contract.
 *   2. The dynamic import in LibsignalSessionCrypto resolves correctly.
 *   3. Future Signal integration simply fills in these function bodies.
 *
 * When activating Phase-2:
 *   npm install @signalapp/libsignal-client   (see bundle-size note below)
 *   Fill in SignalClient.encryptToDevice and SignalClient.buildEnvelopes
 *   Change defaultSession in session.ts to new LibsignalSessionCrypto()
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { DeviceRecord, MessageEnvelope } from './crypto.js';

// ─── Placeholder store types ──────────────────────────────────────────────────
// Production: implement SignalProtocolStore backed by IndexedDB.
// These stubs satisfy TypeScript without pulling in the real library.

export interface SignalProtocolAddress {
  deviceId: string;
  identityPublicKey: string;
}

export interface EncryptedMessage {
  ciphertext: string;
  type: 'PreKeySignalMessage' | 'SignalMessage';
}

// ─── SignalClient namespace ───────────────────────────────────────────────────

export const SignalClient = {
  /**
   * Encrypt plaintext to a single device using Signal Double-Ratchet.
   *
   * Phase-2 implementation outline:
   *  1. Look up / create a SessionBuilder for the device address
   *  2. If no session exists, perform X3DH key agreement using the device's
   *     prekey bundle (identityKey + signedPreKey + oneTimePreKey)
   *  3. Encrypt via SessionCipher.encrypt() → PreKeySignalMessage (first msg)
   *     or SignalMessage (subsequent)
   *  4. Serialize and base64-encode
   *
   * @signalapp/libsignal-client API reference:
   *   https://github.com/signalapp/libsignal/tree/main/node
   */
  async encryptToDevice(plaintext: string, device: DeviceRecord): Promise<string> {
    // TODO(phase-2): Replace with real @signalapp/libsignal-client call.
    // Example (requires npm install @signalapp/libsignal-client):
    //
    //   const { SignalProtocolAddress, SessionStore, SessionCipher } =
    //     await import('@signalapp/libsignal-client');
    //
    //   const address = SignalProtocolAddress.new(device.userId, +device.id);
    //   const sessionStore = getOrCreateSessionStore(); // IndexedDB-backed
    //   const cipher = new SessionCipher(sessionStore, identityStore, address);
    //   const encrypted = await cipher.encrypt(Buffer.from(plaintext, 'utf8'));
    //   return encrypted.serialize().toString('base64');

    void device; // suppress unused warning on stub
    throw new Error(
      '[signalClient] Phase-2 not yet activated. ' +
        'Set defaultSession = new LibsignalSessionCrypto() in session.ts ' +
        'and implement this function after installing @signalapp/libsignal-client.',
    );
  },

  /**
   * Encrypt plaintext to all devices and return the full envelope array.
   *
   * Phase-2 implementation outline:
   *  1. For each device: encryptToDevice()
   *  2. Map results to MessageEnvelope[]
   *
   * Fanout is intentionally sequential here for correctness (ratchet state
   * must not be shared across concurrent encryptions for the same session).
   * Use Promise.allSettled across *different* devices — the ratchet is
   * per-device, so device A's ratchet is independent of device B's.
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
