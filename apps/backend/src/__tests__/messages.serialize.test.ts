import { describe, expect, it } from 'vitest';
import { serializeMessage } from '../lib/messages.js';

describe('serializeMessage', () => {
  it('prefers envelope ciphertext and never exposes the base ciphertext when the server cannot decrypt', () => {
    const message = {
      id: 'msg-1',
      senderId: 'user-a',
      senderDeviceId: 'dev-a',
      contentType: 'text/plain',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      ciphertext: 'server-side-base-ciphertext',
      envelopes: [{ ciphertext: 'encrypted-for-device' }],
    };

    const serialized = serializeMessage(message);

    expect(serialized.ciphertext).toBe('encrypted-for-device');
    expect(serialized).not.toHaveProperty('envelopes');
    expect(serialized).not.toHaveProperty('deletedAt');
  });
});
