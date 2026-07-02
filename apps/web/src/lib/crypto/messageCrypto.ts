// E2EE decryption shim
// In production this would perform X3DH / Double Ratchet decryption
// against the per-device envelope ciphertext.
// For local search (#185) we need the plaintext, so we decrypt here
// before indexing into IndexedDB.
//
// Server-side search over ciphertext was removed in #124 –
// we now search only over messages this device has decrypted.

export interface EncryptedMessageInput {
  id: string;
  conversationId: string;
  senderId: string;
  ciphertext: string | null;
  contentType: string;
  createdAt: string | Date;
  sequenceNumber?: number | null;
}

/**
 * Decrypt a message envelope.
 * TODO: Replace with real Signal Protocol / X3DH implementation.
 * Currently returns ciphertext verbatim (the backend test fixtures
 * store plaintext in ciphertext for development).
 */
export async function decryptMessageText(ciphertext: string | null): Promise<string> {
  if (!ciphertext) return '';
  // Placeholder: in a real client, look up the message_envelope for
  // this device, decrypt with the session key, verify auth tag, etc.
  // For local search development we treat ciphertext as plaintext.
  return ciphertext;
}

export async function decryptMessage(msg: EncryptedMessageInput): Promise<string> {
  return decryptMessageText(msg.ciphertext);
}
