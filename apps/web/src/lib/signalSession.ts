/**
 * signalSession.ts — per-device Signal sessions (issue: multi-device Signal,
 * sessions per sibling device).
 *
 * Signal addresses sessions by (userId, deviceId), never by user alone: a
 * user with three linked devices is three independent encryption targets,
 * each with its own X3DH-established session and its own forward-secret
 * message chain. This module is that per-device session store — the
 * `SignalProtocolStore` referenced in signalClient.ts's original stub
 * comments.
 *
 * Simplification vs. full Signal Double Ratchet: this implements the
 * sending side as a symmetric-key (hash) ratchet seeded by X3DH — each
 * message derives a fresh message key via HKDF and advances the chain key,
 * so a compromised message key cannot be used to recover past or future
 * ones (forward secrecy). It does not perform the Diffie-Hellman ratchet
 * step (deriving new DH shared secrets per round-trip for break-in
 * recovery) — that needs the receiver's ratchet public keys flowing back
 * over the wire via @signalapp/libsignal-client once Phase-2 is activated
 * (see docs/signal-integration.md). `SignalClient`'s public interface does
 * not change when that happens — this module is a drop-in swap.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { onSessionReset } from './identityTrust.js';
import {
  initiateSession,
  rawEd25519PublicKeyToSpki,
  toBase64,
  type IdentityKeyPair,
  type InitialMessageHeader,
  type PreKeyBundle,
} from './x3dh.js';

export type { InitialMessageHeader };

export interface DeviceSession {
  deviceId: string;
  sendChainKey: Uint8Array;
  sendMessageNumber: number;
  associatedData: Uint8Array;
  /** Cleared after the first message is sent — only that message needs it. */
  pendingInitialMessageHeader: InitialMessageHeader | null;
}

// One entry per target *device* id — the core multi-device invariant. A
// user's five linked devices are five independent map entries here, never
// collapsed into a single "user session". Fanning out a message to N
// devices (buildEnvelopes) drives N independent entries of this map.
const sessions = new Map<string, DeviceSession>();

// Session reset / re-handshake on key change (identityTrust.ts): tearing
// down a device's session here forces the next `ensureSession` call to
// treat it as first contact again and re-run X3DH from scratch instead of
// resuming a session for a superseded identity key.
onSessionReset((deviceIds) => {
  for (const id of deviceIds) sessions.delete(id);
});

export function hasSession(deviceId: string): boolean {
  return sessions.has(deviceId);
}

export function getSession(deviceId: string): DeviceSession | undefined {
  return sessions.get(deviceId);
}

export function deleteSession(deviceId: string): void {
  sessions.delete(deviceId);
}

/** Clears every session — test/sign-out helper. */
export function clearAllSessions(): void {
  sessions.clear();
}

function deriveChainKey(sessionKey: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, sessionKey, undefined, new TextEncoder().encode(label), 32);
}

/**
 * Establishes a brand-new session for `deviceId` from its published prekey
 * bundle — the "new sibling/recipient device establishes a session on
 * first contact" path. Verifies the signed prekey (x3dh.ts) before trusting
 * anything in the bundle, exactly as X3DH's initiator side requires.
 */
export function establishSession(
  deviceId: string,
  bundle: PreKeyBundle,
  myIdentity: IdentityKeyPair,
): DeviceSession {
  const x3dh = initiateSession(bundle, myIdentity);

  const session: DeviceSession = {
    deviceId,
    // Two independent HKDF outputs from the same X3DH secret: the sending
    // chain key must never equal the raw session key, and keeping them
    // derived-but-distinct means a future receiving-chain addition (full
    // Double Ratchet) doesn't have to renegotiate this derivation.
    sendChainKey: deriveChainKey(x3dh.sessionKey, 'clicked-session-chain-v1'),
    sendMessageNumber: 0,
    associatedData: x3dh.associatedData,
    pendingInitialMessageHeader: {
      // Wire format is the 44-byte SPKI DER wrapping, matching what
      // completeSession() expects (it round-trips via spkiToRawEd25519PublicKey)
      // and what the backend stores for identityPublicKey (lib/keys.ts).
      senderIdentityPublicKey: toBase64(rawEd25519PublicKeyToSpki(myIdentity.publicKey)),
      ephemeralPublicKey: toBase64(x3dh.ephemeralPublicKey),
      usedSignedPreKeyId: bundle.signedPreKey.keyId,
      usedOneTimePreKeyId: x3dh.usedOneTimePreKeyId,
    },
  };

  sessions.set(deviceId, session);
  return session;
}

export interface RatchetStep {
  messageKey: Uint8Array;
  messageNumber: number;
  associatedData: Uint8Array;
  /** Set only on the very first message sent on a freshly-established session. */
  initialMessageHeader: InitialMessageHeader | null;
}

/**
 * Advances `deviceId`'s sending chain by one step: derives this message's
 * key from the current chain key, then replaces the chain key with a
 * different HKDF output of itself. The discarded key cannot be recomputed
 * from its successor, so compromising one message key never exposes
 * earlier or later messages in the same session (forward secrecy).
 */
export function ratchetEncryptStep(deviceId: string): RatchetStep {
  const session = sessions.get(deviceId);
  if (!session) {
    throw new Error(
      `No Signal session established for device ${deviceId} — call establishSession first`,
    );
  }

  const stepInfo = new TextEncoder().encode(`clicked-msg-key-${session.sendMessageNumber}`);
  const messageKey = hkdf(sha256, session.sendChainKey, undefined, stepInfo, 32);
  session.sendChainKey = deriveChainKey(session.sendChainKey, 'clicked-chain-step-v1');
  session.sendMessageNumber += 1;

  const initialMessageHeader = session.pendingInitialMessageHeader;
  session.pendingInitialMessageHeader = null; // only the first message carries it

  return {
    messageKey,
    messageNumber: session.sendMessageNumber,
    associatedData: session.associatedData,
    initialMessageHeader,
  };
}
