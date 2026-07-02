/**
 * session.ts — Signal Protocol session interface (web)
 *
 * Defines the `SessionCrypto` interface that abstracts the underlying
 * cryptographic library used for message encryption. Phase-1 uses the
 * sealed-box implementation from crypto.ts (WebCrypto ECDH + AES-GCM).
 * Phase-2 (this task) wires in @signalapp/libsignal-client behind the
 * same interface so no calling code changes.
 *
 * Swapping the implementation is a one-line change in session.ts:
 *   - Phase-1: export { Phase1SessionCrypto as defaultSession }
 *   - Phase-2: export { LibsignalSessionCrypto as defaultSession }
 *
 * Audit status and bundle-size impact are documented in
 * docs/signal-integration.md (created in this commit).
 */

import type { DeviceRecord, MessageEnvelope } from './crypto.js';
import { buildEnvelopes as phase1BuildEnvelopes, sealedBoxEncrypt } from './crypto.js';

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * SessionCrypto — the abstraction boundary between the UI layer and the
 * underlying Signal / E2EE library.
 *
 * All callers (sendEncryptedMessage, sendEncryptedFile, etc.) go through
 * this interface so the library can be swapped without touching application
 * code.
 */
export interface SessionCrypto {
  /**
   * Encrypt `plaintext` to a single device's identity key.
   * Returns base64 ciphertext.
   */
  encryptToDevice(plaintext: string, device: DeviceRecord): Promise<string>;

  /**
   * Encrypt `plaintext` to every device in `devices` and return the
   * full envelope array ready for send_message.
   */
  buildEnvelopes(plaintext: string, devices: DeviceRecord[]): Promise<MessageEnvelope[]>;
}

// ─── Phase-1 implementation (sealed-box / WebCrypto) ─────────────────────────

/**
 * Phase-1 SessionCrypto implementation.
 *
 * Uses WebCrypto ECDH + HKDF + AES-256-GCM sealed-box from crypto.ts.
 * No ratchet — each message uses a fresh ephemeral key pair.
 *
 * This path is cleanly swappable: replace `defaultSession` export below
 * and nothing above this file changes.
 */
export class Phase1SessionCrypto implements SessionCrypto {
  async encryptToDevice(plaintext: string, device: DeviceRecord): Promise<string> {
    return sealedBoxEncrypt(plaintext, device.identityPublicKey);
  }

  async buildEnvelopes(plaintext: string, devices: DeviceRecord[]): Promise<MessageEnvelope[]> {
    return phase1BuildEnvelopes(plaintext, devices);
  }
}

// ─── Phase-2 implementation (@signalapp/libsignal-client) ────────────────────

/**
 * LibsignalSessionCrypto — wraps @signalapp/libsignal-client (Signal Protocol).
 *
 * The library is loaded lazily via a dynamic import so it does not bloat the
 * initial bundle for users who have not yet established a Signal session.
 *
 * Audit status and bundle-size analysis: see docs/signal-integration.md
 *
 * This implementation satisfies the SessionCrypto interface; no callsite
 * changes are required when activating this path.
 */
export class LibsignalSessionCrypto implements SessionCrypto {
  /**
   * Encrypt a plaintext to a single device using Signal's sealed-sender
   * mechanism (SealedSenderEncryptionResult).
   *
   * The Signal ratchet state for each device is stored in the
   * SignalProtocolStore implementation (InMemorySignalProtocolStore).
   * Persistent session state should be stored in IndexedDB for
   * production deployments.
   */
  async encryptToDevice(plaintext: string, device: DeviceRecord): Promise<string> {
    // Dynamic import — tree-shake libsignal out of the initial bundle.
    // @signalapp/libsignal-client ships WASM; the dynamic import also avoids
    // SSR issues in Next.js since WASM cannot be initialised server-side.
    const { SignalClient } = await import('./signalClient.js');
    return SignalClient.encryptToDevice(plaintext, device);
  }

  async buildEnvelopes(plaintext: string, devices: DeviceRecord[]): Promise<MessageEnvelope[]> {
    const { SignalClient } = await import('./signalClient.js');
    return SignalClient.buildEnvelopes(plaintext, devices);
  }
}

// ─── Active implementation ────────────────────────────────────────────────────

/**
 * The active SessionCrypto implementation used by the entire application.
 *
 * To activate Phase-2 (Signal Protocol), replace Phase1SessionCrypto with
 * LibsignalSessionCrypto here. No other changes are required.
 */
export const defaultSession: SessionCrypto = new Phase1SessionCrypto();
