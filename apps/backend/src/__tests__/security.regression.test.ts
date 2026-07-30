import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateMessagePayload } from '../lib/validateMessagePayload.js';
import { SendMessageSchema } from '../schemas/message.schemas.js';

/**
 * Security regression checks (#388).
 *
 * These tests fail CI the moment any code path starts accepting a
 * plaintext-only message, or any schema/route grows a field that could
 * carry a raw private key or Signal session-state blob. They are a guard
 * against regressions, not a substitute for the crypto design itself.
 */

const FORBIDDEN_FIELD_NAMES = [
  'plaintext',
  'plainText',
  'privateKey',
  'private_key',
  'sessionState',
  'session_state',
  'signalSession',
  'identityPrivateKey',
  'preKeyPrivate',
];

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (extname(entry.name) === '.ts') {
      files.push(full);
    }
  }
  return files;
}

describe('security regression: ciphertext-only guard', () => {
  it('rejects a text message with plaintext content and no envelopes', () => {
    const result = validateMessagePayload({
      contentType: 'text',
      // @ts-expect-error - deliberately probing for a plaintext field the type doesn't allow
      plaintext: 'hello in the clear',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a text message that supplies ciphertext but no per-device envelopes', () => {
    const result = validateMessagePayload({
      contentType: 'text',
      ciphertext: 'some-ciphertext',
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a text message only when envelopes carry the encrypted key', () => {
    const result = validateMessagePayload({
      contentType: 'text',
      envelopes: [{ recipientDeviceId: 'device-1', ciphertext: 'enc-key' }],
    });
    expect(result.ok).toBe(true);
  });

  it('REST SendMessageSchema has no plaintext field', () => {
    const shape = SendMessageSchema.shape as Record<string, unknown>;
    expect(Object.keys(shape)).not.toContain('plaintext');
    expect(Object.keys(shape)).not.toContain('plainText');
  });
});

describe('security regression: no private-key/session-state field is ever accepted', () => {
  const sourceFiles = listSourceFiles(SRC_ROOT);

  it('scanned at least one route/schema file', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_FIELD_NAMES)('no source file declares a "%s" field', (fieldName) => {
    const offenders: string[] = [];
    // Matches z.object key declarations and TS interface/type field declarations,
    // e.g. `privateKey:` — not matched inside comments-only prose or unrelated words.
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${fieldName}\\s*[:?]\\s*[^,]`, 'm');

    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      if (pattern.test(content)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
