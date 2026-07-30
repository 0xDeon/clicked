export type MessageLike = {
  id: string;
  senderId: string;
  senderDeviceId?: string | null;
  contentType: string;
  createdAt: Date;
  content?: unknown;
  ciphertext?: string | null;
  /**
   * Structured, server-generated metadata for `contentType === 'system'` rows.
   * Always null for every other content type.
   */
  systemPayload?: { userId: string; change: string } | null;
  deletedAt?: Date | null;
  envelopes?: Array<{ ciphertext: string }>;
  [key: string]: unknown;
};

export function serializeMessage<T extends MessageLike>(
  message: T,
): Omit<T, 'deletedAt' | 'envelopes' | 'ciphertext' | 'content'> & {
  ciphertext: string | null;
  unavailable?: boolean;
} {
  const { deletedAt, envelopes, ciphertext: baseCiphertext, content, ...rest } = message;

  if (deletedAt) {
    return {
      ...rest,
      ciphertext: null,
    };
  }

  // System messages carry their content in `systemPayload`, never in
  // `ciphertext`. They are always readable by every client, so they must not
  // be flagged `unavailable` just because `ciphertext` is null.
  if (message.contentType === 'system') {
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
