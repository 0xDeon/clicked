/**
 * Unit tests for src/lib/keys.ts
 *
 * Covers: isValidBase64, base64ByteLength, all Zod schemas,
 * composite schemas, and verifyEd25519Signature.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidBase64,
  base64ByteLength,
  IdentityPublicKeySchema,
  PreKeyPublicKeySchema,
  SignatureSchema,
  MlsKeyPackageSchema,
  PreKeyEntrySchema,
  SignedPreKeyEntrySchema,
  verifyEd25519Signature,
} from '../lib/keys.js';

function b64OfLength(bytes: number): string {
  return Buffer.alloc(bytes).toString('base64');
}

// ─── isValidBase64 ────────────────────────────────────────────────────────────

describe('isValidBase64', () => {
  it('accepts valid padded base64', () => {
    expect(isValidBase64('AAAA')).toBe(true);
    expect(isValidBase64('AA==')).toBe(true);
    expect(isValidBase64('AAA=')).toBe(true);
    expect(isValidBase64(b64OfLength(32))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBase64('')).toBe(false);
  });

  it('rejects strings with invalid characters', () => {
    expect(isValidBase64('not-base64!')).toBe(false);
  });

  it('rejects strings with wrong padding length', () => {
    expect(isValidBase64('AA')).toBe(false);
  });
});

// ─── base64ByteLength ─────────────────────────────────────────────────────────

describe('base64ByteLength', () => {
  it('returns correct byte count', () => {
    expect(base64ByteLength(b64OfLength(32))).toBe(32);
    expect(base64ByteLength(b64OfLength(44))).toBe(44);
    expect(base64ByteLength(b64OfLength(64))).toBe(64);
  });

  it('returns -1 for invalid base64', () => {
    expect(base64ByteLength('not-valid!')).toBe(-1);
    expect(base64ByteLength('')).toBe(-1);
  });
});

// ─── IdentityPublicKeySchema (44-byte SPKI DER) ───────────────────────────────

describe('IdentityPublicKeySchema', () => {
  it('accepts a valid 44-byte SPKI key', () => {
    expect(IdentityPublicKeySchema.safeParse(b64OfLength(44)).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(IdentityPublicKeySchema.safeParse('').success).toBe(false);
  });

  it('rejects non-base64 input', () => {
    const r = IdentityPublicKeySchema.safeParse('not-base64!!');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/base64/i);
  });

  it('rejects a 32-byte key — wrong length', () => {
    const r = IdentityPublicKeySchema.safeParse(b64OfLength(32));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/44 bytes/);
  });

  it('rejects a 64-byte key', () => {
    expect(IdentityPublicKeySchema.safeParse(b64OfLength(64)).success).toBe(false);
  });
});

// ─── PreKeyPublicKeySchema (32-byte raw Ed25519) ──────────────────────────────

describe('PreKeyPublicKeySchema', () => {
  it('accepts a valid 32-byte key', () => {
    expect(PreKeyPublicKeySchema.safeParse(b64OfLength(32)).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(PreKeyPublicKeySchema.safeParse('').success).toBe(false);
  });

  it('rejects non-base64 input', () => {
    const r = PreKeyPublicKeySchema.safeParse('!!!');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/base64/i);
  });

  it('rejects a 44-byte key — wrong length', () => {
    const r = PreKeyPublicKeySchema.safeParse(b64OfLength(44));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/32 bytes/);
  });
});

// ─── SignatureSchema (64-byte Ed25519 signature) ──────────────────────────────

describe('SignatureSchema', () => {
  it('accepts a valid 64-byte signature', () => {
    expect(SignatureSchema.safeParse(b64OfLength(64)).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(SignatureSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-base64 input', () => {
    const r = SignatureSchema.safeParse('not_base64!!!');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/base64/i);
  });

  it('rejects a 32-byte value — too short', () => {
    const r = SignatureSchema.safeParse(b64OfLength(32));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/64 bytes/);
  });
});

// ─── MlsKeyPackageSchema (32–4096 bytes) ──────────────────────────────────────

describe('MlsKeyPackageSchema', () => {
  it('accepts minimum (32 bytes)', () => {
    expect(MlsKeyPackageSchema.safeParse(b64OfLength(32)).success).toBe(true);
  });

  it('accepts maximum (4096 bytes)', () => {
    expect(MlsKeyPackageSchema.safeParse(b64OfLength(4096)).success).toBe(true);
  });

  it('rejects below minimum (31 bytes)', () => {
    const r = MlsKeyPackageSchema.safeParse(b64OfLength(31));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/32/);
  });

  it('rejects above maximum (4097 bytes)', () => {
    const r = MlsKeyPackageSchema.safeParse(b64OfLength(4097));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/4096/);
  });

  it('rejects non-base64', () => {
    expect(MlsKeyPackageSchema.safeParse('not-base64!!!').success).toBe(false);
  });
});

// ─── PreKeyEntrySchema ────────────────────────────────────────────────────────

describe('PreKeyEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(PreKeyEntrySchema.safeParse({ keyId: 1, publicKey: b64OfLength(32) }).success).toBe(
      true,
    );
  });

  it('rejects negative keyId', () => {
    expect(PreKeyEntrySchema.safeParse({ keyId: -1, publicKey: b64OfLength(32) }).success).toBe(
      false,
    );
  });

  it('rejects wrong-length publicKey', () => {
    expect(PreKeyEntrySchema.safeParse({ keyId: 0, publicKey: b64OfLength(16) }).success).toBe(
      false,
    );
  });
});

// ─── SignedPreKeyEntrySchema ──────────────────────────────────────────────────

describe('SignedPreKeyEntrySchema', () => {
  const valid = { keyId: 1, publicKey: b64OfLength(32), signature: b64OfLength(64) };

  it('accepts a valid signed prekey', () => {
    expect(SignedPreKeyEntrySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects missing signature', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { signature: _, ...noSig } = valid;
    expect(SignedPreKeyEntrySchema.safeParse(noSig).success).toBe(false);
  });

  it('rejects wrong-length signature', () => {
    expect(
      SignedPreKeyEntrySchema.safeParse({ ...valid, signature: b64OfLength(32) }).success,
    ).toBe(false);
  });

  it('rejects non-base64 signature', () => {
    expect(SignedPreKeyEntrySchema.safeParse({ ...valid, signature: 'bad!' }).success).toBe(false);
  });

  it('rejects wrong-length publicKey', () => {
    expect(
      SignedPreKeyEntrySchema.safeParse({ ...valid, publicKey: b64OfLength(44) }).success,
    ).toBe(false);
  });
});

// ─── verifyEd25519Signature ───────────────────────────────────────────────────

describe('verifyEd25519Signature', () => {
  it('returns true for a valid signature', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const payload = Buffer.from('test-prekey-bytes');
    const payloadB64 = payload.toString('base64');
    const sigB64 = sign(null, payload, privateKey).toString('base64');
    expect(verifyEd25519Signature(spkiB64, payloadB64, sigB64)).toBe(true);
  });

  it('returns false when signature is wrong', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('ed25519');
    const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(verifyEd25519Signature(spkiB64, b64OfLength(32), b64OfLength(64))).toBe(false);
  });

  it('returns false when identity key is garbage', () => {
    expect(verifyEd25519Signature('notakey==', b64OfLength(32), b64OfLength(64))).toBe(false);
  });

  it('never throws — returns false on any exception', () => {
    expect(() => verifyEd25519Signature('', '', '')).not.toThrow();
    expect(verifyEd25519Signature('', '', '')).toBe(false);
  });
});
