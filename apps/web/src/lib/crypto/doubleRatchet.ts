import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

export const MAX_SKIP = 100;
export const MAX_SKIPPED_KEYS = 1000;

const INFO_RK = new TextEncoder().encode('DoubleRatchetRK');
const INFO_CK = new TextEncoder().encode('DoubleRatchetCK');
const INFO_MESSAGE_KEY = new TextEncoder().encode('DoubleRatchetMK');

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface Header {
  dh: Uint8Array;
  pn: number;
  n: number;
}

export interface EncryptedMessagePayload {
  header: {
    dh: string; // base64
    pn: number;
    n: number;
  };
  ciphertext: string; // base64
  iv: string; // base64
}

export interface DoubleRatchetState {
  DHs: KeyPair;
  DHr: Uint8Array | null;
  RK: Uint8Array;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, Uint8Array>;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function toBufferSource(arr: Uint8Array): BufferSource {
  return new Uint8Array(Array.from(arr));
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function kdfRk(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array } {
  const derived = hkdf(sha256, dhOut, rk, INFO_RK, 64);
  return {
    rk: derived.slice(0, 32),
    ck: derived.slice(32, 64),
  };
}

export function kdfCk(ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  const nextCk = hkdf(sha256, new Uint8Array([0x01]), ck, INFO_CK, 32);
  const mk = hkdf(sha256, new Uint8Array([0x02]), ck, INFO_MESSAGE_KEY, 32);
  return { ck: nextCk, mk };
}

function skippedKeyId(dhPub: Uint8Array | null, n: number): string {
  const dhB64 = dhPub ? toBase64(dhPub) : 'none';
  return `${dhB64}:${n}`;
}

export function initAlice(sharedKey: Uint8Array, bobDhPublicKey: Uint8Array): DoubleRatchetState {
  const DHs = generateKeyPair();
  const DHr = bobDhPublicKey;
  const dhOut = x25519.getSharedSecret(DHs.privateKey, DHr);
  const { rk: RK, ck: CKs } = kdfRk(sharedKey, dhOut);

  return {
    DHs,
    DHr,
    RK,
    CKs,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

export function initBob(sharedKey: Uint8Array, bobKeyPair: KeyPair): DoubleRatchetState {
  return {
    DHs: bobKeyPair,
    DHr: null,
    RK: sharedKey,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
}

function pruneSkippedKeys(mkSkipped: Map<string, Uint8Array>): void {
  while (mkSkipped.size > MAX_SKIPPED_KEYS) {
    const firstKey = mkSkipped.keys().next().value;
    if (firstKey !== undefined) {
      mkSkipped.delete(firstKey);
    } else {
      break;
    }
  }
}

export function skipMessageKeys(state: DoubleRatchetState, until: number): void {
  if (state.Nr + MAX_SKIP < until) {
    throw new Error('Too many skipped messages');
  }

  if (state.CKr) {
    while (state.Nr < until) {
      const { ck, mk } = kdfCk(state.CKr);
      state.CKr = ck;
      const keyId = skippedKeyId(state.DHr, state.Nr);
      state.MKSKIPPED.set(keyId, mk);
      pruneSkippedKeys(state.MKSKIPPED);
      state.Nr++;
    }
  }
}

async function encryptAesGcm(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const cryptoKey = await crypto.subtle.importKey('raw', toBufferSource(key), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: toBufferSource(ad) },
    cryptoKey,
    toBufferSource(plaintext),
  );
  return { ciphertext: new Uint8Array(encrypted), iv };
}

async function decryptAesGcm(key: Uint8Array, ciphertext: Uint8Array, iv: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', toBufferSource(key), { name: 'AES-GCM' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv), additionalData: toBufferSource(ad) },
    cryptoKey,
    toBufferSource(ciphertext),
  );
  return new Uint8Array(decrypted);
}

export async function ratchetEncrypt(
  state: DoubleRatchetState,
  plaintext: string | Uint8Array,
  associatedData: Uint8Array = new Uint8Array(0),
): Promise<EncryptedMessagePayload> {
  if (!state.CKs) {
    throw new Error('Send chain key not initialized');
  }

  const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const { ck, mk } = kdfCk(state.CKs);
  state.CKs = ck;

  const header: Header = {
    dh: state.DHs.publicKey,
    pn: state.PN,
    n: state.Ns,
  };

  state.Ns++;

  const { ciphertext, iv } = await encryptAesGcm(mk, plaintextBytes, associatedData);

  return {
    header: {
      dh: toBase64(header.dh),
      pn: header.pn,
      n: header.n,
    },
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
  };
}

export async function ratchetDecrypt(
  state: DoubleRatchetState,
  payload: EncryptedMessagePayload,
  associatedData: Uint8Array = new Uint8Array(0),
): Promise<string> {
  const headerDh = fromBase64(payload.header.dh);
  const ciphertext = fromBase64(payload.ciphertext);
  const iv = fromBase64(payload.iv);

  const keyId = skippedKeyId(headerDh, payload.header.n);
  if (state.MKSKIPPED.has(keyId)) {
    const mk = state.MKSKIPPED.get(keyId)!;
    state.MKSKIPPED.delete(keyId);
    const plaintextBytes = await decryptAesGcm(mk, ciphertext, iv, associatedData);
    return new TextDecoder().decode(plaintextBytes);
  }

  const dhChanged =
    !state.DHr ||
    headerDh.length !== state.DHr.length ||
    !headerDh.every((b, i) => b === state.DHr![i]);

  if (dhChanged) {
    skipMessageKeys(state, payload.header.pn);

    state.DHr = headerDh;
    const dhSendReceive = x25519.getSharedSecret(state.DHs.privateKey, state.DHr);
    const { rk: rk1, ck: ckRecv } = kdfRk(state.RK, dhSendReceive);
    state.RK = rk1;
    state.CKr = ckRecv;

    state.DHs = generateKeyPair();
    const dhSendSend = x25519.getSharedSecret(state.DHs.privateKey, state.DHr);
    const { rk: rk2, ck: ckSend } = kdfRk(state.RK, dhSendSend);
    state.RK = rk2;
    state.CKs = ckSend;

    state.PN = state.Ns;
    state.Ns = 0;
    state.Nr = 0;
  }

  skipMessageKeys(state, payload.header.n);

  if (!state.CKr) {
    throw new Error('Receive chain key not initialized');
  }

  const { ck, mk } = kdfCk(state.CKr);
  state.CKr = ck;
  state.Nr++;

  const plaintextBytes = await decryptAesGcm(mk, ciphertext, iv, associatedData);
  return new TextDecoder().decode(plaintextBytes);
}
