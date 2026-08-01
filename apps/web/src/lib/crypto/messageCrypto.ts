import { decryptAndVerifyEnvelope } from './decrypt';

export interface EncryptedMessageInput {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: string | null;
  senderIdentityPublicKey?: string | null;
  ciphertext: string | null;
  contentType: string;
  createdAt: string | Date;
  sequenceNumber?: number | null;
}

/**
 * Decrypt a message envelope using the real E2EE decryption pipeline.
 * Returns the decrypted plaintext, or null if the message cannot be decrypted
 * (e.g. invalid signature, missing session key, undecryptable envelope).
 */
export async function decryptMessageText(
  ciphertext: string | null,
  senderDeviceId?: string | null,
  senderIdentityPublicKey?: string | null,
): Promise<string | null> {
  if (!ciphertext) return null;

  try {
    // If senderDeviceId and identity key are provided, attempt real envelope decryption
    if (senderDeviceId && senderIdentityPublicKey) {
      return await decryptAndVerifyEnvelope(ciphertext, senderDeviceId, senderIdentityPublicKey);
    }

    // Check if ciphertext appears to be a base64-encoded envelope JSON payload
    let isEnvelope = false;
    try {
      const decoded =
        typeof Buffer !== 'undefined'
          ? Buffer.from(ciphertext, 'base64').toString('utf8')
          : atob(ciphertext);
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object' && parsed.v === 1 && parsed.iv && parsed.ct) {
        isEnvelope = true;
      }
    } catch {
      isEnvelope = false;
    }

    // If it's an envelope but missing keys to decrypt, decryption fails
    if (isEnvelope) {
      if (senderDeviceId && senderIdentityPublicKey) {
        return await decryptAndVerifyEnvelope(ciphertext, senderDeviceId, senderIdentityPublicKey);
      }
      return null;
    }
  } catch {
    // Decryption failed (VerificationFailedError, PreLinkError, DecryptError)
    return null;
  }

  // If not an envelope format (e.g. direct plaintext string), return as-is
  return ciphertext;
}

export async function decryptMessage(msg: EncryptedMessageInput): Promise<string | null> {
  return decryptMessageText(msg.ciphertext, msg.senderDeviceId, msg.senderIdentityPublicKey);
}
