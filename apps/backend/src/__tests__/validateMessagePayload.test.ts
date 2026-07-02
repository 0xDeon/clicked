import { describe, it, expect } from 'vitest';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const envelope = { recipientDeviceId: 'device-uuid-1234', ciphertext: 'enc-key' };
const FILE_ID = 'file-uuid-5678';

// ─── system messages ──────────────────────────────────────────────────────────

describe('system messages', () => {
  it('rejects system contentType with 403', () => {
    const result = validateMessagePayload({ contentType: 'system', envelopes: [envelope] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(403);
      expect(result.message).toMatch(/reserved for the server/i);
    }
  });

  it('rejects "System" (mixed case) with 403 – normalisation applied', () => {
    const result = validateMessagePayload({ contentType: 'System' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(403);
    }
  });

  it('rejects "  system  " (with whitespace) with 403', () => {
    const result = validateMessagePayload({ contentType: '  system  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(403);
    }
  });
});

// ─── unknown content types ────────────────────────────────────────────────────

describe('unknown content types', () => {
  it('rejects an unknown contentType with 400', () => {
    const result = validateMessagePayload({ contentType: 'binary', envelopes: [envelope] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
      expect(result.message).toMatch(/unsupported contentType/i);
    }
  });
});

// ─── text messages ────────────────────────────────────────────────────────────

describe('text messages', () => {
  it('rejects text without any envelopes (400)', () => {
    const result = validateMessagePayload({ contentType: 'text' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
      expect(result.message).toMatch(/envelope/i);
    }
  });

  it('rejects text with an empty envelopes array (400)', () => {
    const result = validateMessagePayload({ contentType: 'text', envelopes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
    }
  });

  it('accepts text with at least one envelope', () => {
    const result = validateMessagePayload({ contentType: 'text', envelopes: [envelope] });
    expect(result.ok).toBe(true);
  });

  it('defaults to text when contentType is absent and passes with envelopes', () => {
    const result = validateMessagePayload({ envelopes: [envelope] });
    expect(result.ok).toBe(true);
  });

  it('defaults to text when contentType is absent and rejects without envelopes', () => {
    const result = validateMessagePayload({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
    }
  });
});

// ─── file-type messages ───────────────────────────────────────────────────────

const FILE_TYPES = ['file', 'image', 'video', 'audio'] as const;

describe.each(FILE_TYPES)('%s messages', (contentType) => {
  it(`rejects ${contentType} without fileId (400)`, () => {
    const result = validateMessagePayload({ contentType, envelopes: [envelope] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
      expect(result.message).toMatch(/fileId/i);
    }
  });

  it(`rejects ${contentType} with blank fileId (400)`, () => {
    const result = validateMessagePayload({ contentType, fileId: '   ', envelopes: [envelope] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
    }
  });

  it(`rejects ${contentType} with fileId but no envelopes (400)`, () => {
    const result = validateMessagePayload({ contentType, fileId: FILE_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
      expect(result.message).toMatch(/envelope/i);
    }
  });

  it(`rejects ${contentType} with fileId but empty envelopes array (400)`, () => {
    const result = validateMessagePayload({ contentType, fileId: FILE_ID, envelopes: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
    }
  });

  it(`accepts ${contentType} with fileId and at least one envelope`, () => {
    const result = validateMessagePayload({
      contentType,
      fileId: FILE_ID,
      envelopes: [envelope],
    });
    expect(result.ok).toBe(true);
  });
});

// ─── acceptance-criteria smoke tests ─────────────────────────────────────────

describe('acceptance criteria', () => {
  it('AC1 – clients cannot send system messages (403)', () => {
    const result = validateMessagePayload({ contentType: 'system' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(403);
  });

  it('AC2 – file-type message without fileId is rejected (400)', () => {
    const result = validateMessagePayload({ contentType: 'image', envelopes: [envelope] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });

  it('AC3 – text message without envelopes is rejected (400)', () => {
    const result = validateMessagePayload({ contentType: 'text', ciphertext: 'some-ciphertext' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });
});
