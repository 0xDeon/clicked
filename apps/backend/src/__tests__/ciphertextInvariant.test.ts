import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS,
  findForbiddenCiphertextFields,
} from '../lib/ciphertextInvariant.js';
import { EnvelopeSchema, SendMessageSchema } from '../schemas/message.schemas.js';

const validMessage = {
  conversationId: '550e8400-e29b-41d4-a716-446655440000',
  messageId: '550e8400-e29b-41d4-a716-446655440001',
  contentType: 'text',
  ciphertext: 'encrypted',
};

describe('ciphertext-only invariant', () => {
  it.each(FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS)(
    'rejects forbidden field %s at the message endpoint',
    (field) => {
      const result = SendMessageSchema.safeParse({ ...validMessage, [field]: 'secret' });
      expect(result.success).toBe(false);
    },
  );

  it.each(FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS)(
    'rejects forbidden field %s in an envelope',
    (field) => {
      const result = EnvelopeSchema.safeParse({
        recipientDeviceId: '550e8400-e29b-41d4-a716-446655440002',
        ciphertext: 'encrypted',
        [field]: 'secret',
      });
      expect(result.success).toBe(false);
    },
  );

  it('detects forbidden fields in a payload', () => {
    expect(findForbiddenCiphertextFields({ ciphertext: 'encrypted', plaintext: 'secret' })).toEqual([
      'plaintext',
    ]);
  });
});
