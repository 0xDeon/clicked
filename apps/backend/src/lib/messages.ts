export type MessageLike = {
  id: string;
  senderId: string;
  senderDeviceId?: string | null;
  contentType: string;
  sequenceNumber: number;
  createdAt: Date;
  ciphertext?: string | null;
  deletedAt?: Date | null;
  envelopes?: Array<{ ciphertext: string }>;
  [key: string]: any;
};

export function serializeMessage<T extends MessageWithEnvelopes>(
  message: T,
): Omit<T, 'deletedAt' | 'envelopes' | 'ciphertext'> & {
  ciphertext: string | null;
  unavailable?: boolean;
} {
  const { deletedAt, envelopes, ciphertext: baseCiphertext, ...rest } = message;

  if (deletedAt) {
    return {
      ...rest,
      ciphertext: null,
    };
  }

  // If there's an envelope, its ciphertext takes precedence.
  if (envelopes && envelopes.length > 0) {
    return {
      ...rest,
      ciphertext: envelopes[0]!.ciphertext,
    };
  }

  // If no envelope but we have base ciphertext (e.g. system message or legacy), use it.
  if (baseCiphertext) {
    return {
      ...rest,
      ciphertext: baseCiphertext,
    };
  }

  // Otherwise, it's unavailable.
  return {
    ...rest,
    ciphertext: null,
    unavailable: true,
  };
}
