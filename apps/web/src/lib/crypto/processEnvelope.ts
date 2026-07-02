import { fetchSenderDevicePublicKey } from './deviceKeys';
import { decryptAndVerifyEnvelope } from './decrypt';
import { getCachedPlaintext, setCachedPlaintext } from './plaintextCache';
import {
  DecryptError,
  PreLinkError,
  VerificationFailedError,
  type InboundMessage,
  type UnavailableReason,
} from './types';

export interface EnvelopeInput {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string | null;
  sequenceNumber: number;
  contentType: string;
  createdAt: string;
  ciphertext: string;
}

function unavailableReasonFromError(err: unknown): UnavailableReason {
  if (err instanceof PreLinkError) return 'pre-link';
  if (err instanceof VerificationFailedError) return 'verification-failed';
  if (err instanceof DecryptError) return 'undecryptable';
  return 'undecryptable';
}

/**
 * Process a single inbound envelope: look up sender key, decrypt, verify, cache.
 */
export async function processInboundEnvelope(
  envelope: EnvelopeInput,
  token: string,
): Promise<InboundMessage> {
  const base: InboundMessage = {
    messageId: envelope.messageId,
    conversationId: envelope.conversationId,
    senderId: envelope.senderId,
    senderDeviceId: envelope.senderDeviceId,
    sequenceNumber: envelope.sequenceNumber,
    contentType: envelope.contentType,
    createdAt: envelope.createdAt,
    status: 'pending',
  };

  const cached = getCachedPlaintext(envelope.messageId);
  if (cached) {
    return { ...base, status: 'decrypted', plaintext: cached };
  }

  if (!envelope.senderDeviceId) {
    return { ...base, status: 'unavailable', unavailableReason: 'pre-link' };
  }

  try {
    const deviceKey = await fetchSenderDevicePublicKey(envelope.senderDeviceId, token);
    const plaintext = await decryptAndVerifyEnvelope(
      envelope.ciphertext,
      envelope.senderDeviceId,
      deviceKey.identityPublicKey,
    );
    setCachedPlaintext(envelope.messageId, plaintext);
    return { ...base, status: 'decrypted', plaintext };
  } catch (err) {
    return {
      ...base,
      status: 'unavailable',
      unavailableReason: unavailableReasonFromError(err),
    };
  }
}

export function sortBySequenceNumber(messages: InboundMessage[]): InboundMessage[] {
  return [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export function mergeInboundMessage(
  existing: InboundMessage | undefined,
  incoming: InboundMessage,
): InboundMessage {
  if (!existing) return incoming;
  // Prefer a decrypted result over unavailable/pending.
  if (existing.status === 'decrypted') return existing;
  if (incoming.status === 'decrypted') return { ...existing, ...incoming };
  return { ...existing, ...incoming };
}
