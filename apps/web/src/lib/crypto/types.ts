export type UnavailableReason = 'pre-link' | 'undecryptable' | 'verification-failed';

export type InboundMessageStatus = 'pending' | 'decrypted' | 'unavailable';

/** Live envelope pushed over the socket (#144). */
export interface MessageEnvelopeEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string | null;
  contentType: string;
  sequenceNumber: number;
  createdAt: string;
  envelopeId: string;
  ciphertext: string;
}

/** Cross-node device delivery — ciphertext only until metadata arrives. */
export interface DeviceEnvelopeEvent {
  messageId: string;
  conversationId: string;
  ciphertext: string;
  sequenceNumber: number;
}

/** Envelope returned by GET /sync (#137). */
export interface SyncEnvelope {
  id: string;
  messageId: string;
  conversationId: string;
  ciphertext: string;
  sequenceNumber: number;
  senderId: string;
  senderDeviceId: string | null;
  contentType: string;
  createdAt: string;
  messageCreatedAt: string;
}

/** Parsed ciphertext payload stored in message_envelopes.ciphertext. */
export interface EncryptedEnvelopePayload {
  v: number;
  iv: string;
  ct: string;
  sig?: string;
}

export interface DevicePublicKey {
  id: string;
  userId: string;
  identityPublicKey: string;
}

export interface InboundMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string | null;
  sequenceNumber: number;
  contentType: string;
  createdAt: string;
  status: InboundMessageStatus;
  plaintext?: string;
  unavailableReason?: UnavailableReason;
}

export class PreLinkError extends Error {
  constructor() {
    super('No session established with sender device');
    this.name = 'PreLinkError';
  }
}

export class VerificationFailedError extends Error {
  constructor() {
    super('Envelope signature verification failed');
    this.name = 'VerificationFailedError';
  }
}

export class DecryptError extends Error {
  constructor(message = 'Unable to decrypt envelope') {
    super(message);
    this.name = 'DecryptError';
  }
}
