const DB_NAME = 'driptide-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'double-ratchet-sessions';
const PROTOCOL_VERSION = 1;
const ZERO_SALT = new Uint8Array(32);

type BufferLike = Uint8Array;

export type RatchetEnvelope = {
  recipientDeviceId: string;
  ciphertext: string;
};

type RatchetHeader = {
  v: number;
  dh: string;
  n: number;
  pn: number;
};

type RatchetState = {
  sessionId: string;
  rootKey: string;
  sendChainKey: string;
  receiveChainKey: string;
  sendingPrivateKey: string;
  sendingPublicKey: string;
  remotePublicKey: string;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousSendingLength: number;
  sendRatchetPending: boolean;
  updatedAt: number;
};

type StoredRatchetState = RatchetState & { id: string };

export type RatchetSession = {
  sessionId: string;
  initiator: boolean;
  initialSecret: Uint8Array;
  remotePublicKey?: Uint8Array;
};

function webCrypto(): Crypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API is unavailable');
  }
  return crypto;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function source(value: Uint8Array): BufferSource {
  return value as unknown as BufferSource;
}

function toBase64(value: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    result += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

function fromBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    result[index] = decoded.charCodeAt(index);
  }
  return result;
}

async function hkdf(
  input: BufferLike,
  salt: BufferLike,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const subtle = webCrypto().subtle;
  const key = await subtle.importKey('raw', source(input), 'HKDF', false, ['deriveBits']);
  const result = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: source(salt), info: source(bytes(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(result);
}

async function hmac(keyBytes: Uint8Array, label: string): Promise<Uint8Array> {
  const subtle = webCrypto().subtle;
  const key = await subtle.importKey(
    'raw',
    source(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle.sign('HMAC', key, source(bytes(label))));
}

async function generateDhKeyPair(): Promise<CryptoKeyPair> {
  return (await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
}

async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto().subtle.exportKey('raw', key));
}

async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto().subtle.exportKey('pkcs8', key));
}

async function importPrivateKey(value: Uint8Array): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    'pkcs8',
    source(value),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

async function importPublicKey(value: Uint8Array): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    'raw',
    source(value),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

async function dh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(
    await webCrypto().subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256,
    ),
  );
}

async function rootStep(
  rootKey: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  const material = await hkdf(
    sharedSecret,
    rootKey,
    'DripTide Double Ratchet root step',
    64,
  );
  return {
    rootKey: material.subarray(0, 32),
    chainKey: material.subarray(32, 64),
  };
}

async function chainStep(
  chainKey: Uint8Array,
): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  return {
    messageKey: await hmac(chainKey, 'DripTide Double Ratchet message key'),
    nextChainKey: await hmac(chainKey, 'DripTide Double Ratchet chain key'),
  };
}

function headerBytes(header: RatchetHeader): Uint8Array {
  return bytes(JSON.stringify(header));
}

async function encryptWithKey(
  messageKey: Uint8Array,
  plaintext: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  webCrypto().getRandomValues(iv);
  const key = await webCrypto().subtle.importKey(
    'raw',
    source(messageKey),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const encrypted = new Uint8Array(
    await webCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv: source(iv), additionalData: source(aad) },
      key,
      source(bytes(plaintext)),
    ),
  );
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv);
  result.set(encrypted, iv.length);
  return result;
}

async function decryptWithKey(
  messageKey: Uint8Array,
  payload: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  if (payload.length < 13) throw new Error('Invalid ratchet ciphertext');
  const key = await webCrypto().subtle.importKey(
    'raw',
    source(messageKey),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: source(payload.subarray(0, 12)),
      additionalData: source(aad),
    },
    key,
    source(payload.subarray(12)),
  );
  return text(new Uint8Array(plaintext));
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('IndexedDB is unavailable; ratchet state cannot be persisted'),
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to open crypto database'));
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readState(sessionId: string): Promise<RatchetState | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .get(sessionId);
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to read ratchet state'));
    };
    request.onsuccess = () => resolve(request.result as RatchetState | undefined);
  });
}

async function writeState(state: RatchetState): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .put({ ...state, id: state.sessionId } satisfies StoredRatchetState);
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to write ratchet state'));
    };
    request.onsuccess = () => resolve();
  });
}

export async function deleteRatchetSession(sessionId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .delete(sessionId);
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to delete ratchet state'));
    };
    request.onsuccess = () => resolve();
  });
}

export async function createRatchetSession(session: RatchetSession): Promise<void> {
  if (!session.sessionId) throw new Error('Ratchet sessionId is required');
  if (session.initialSecret.length < 32) {
    throw new Error('Ratchet initial secret must be at least 32 bytes');
  }
  if (await readState(session.sessionId)) return;

  const pair = await generateDhKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const privateKey = await exportPrivateKey(pair.privateKey);
  const initial = await hkdf(
    session.initialSecret,
    ZERO_SALT,
    'DripTide Double Ratchet initial root',
    64,
  );
  const initialSendChain = initial.subarray(32, 64);
  const initialReceiveChain = await hkdf(
    initial.subarray(0, 32),
    initialSendChain,
    'DripTide receive chain',
    32,
  );

  await writeState({
    sessionId: session.sessionId,
    rootKey: toBase64(initial.subarray(0, 32)),
    sendChainKey: toBase64(session.initiator ? initialSendChain : initialReceiveChain),
    receiveChainKey: toBase64(session.initiator ? initialReceiveChain : initialSendChain),
    sendingPrivateKey: toBase64(privateKey),
    sendingPublicKey: toBase64(publicKey),
    remotePublicKey: session.remotePublicKey ? toBase64(session.remotePublicKey) : '',
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingLength: 0,
    sendRatchetPending: !session.initiator,
    updatedAt: Date.now(),
  });
}

export async function loadRatchetSession(sessionId: string): Promise<boolean> {
  return (await readState(sessionId)) !== undefined;
}

async function performSendingRatchet(state: RatchetState): Promise<void> {
  if (!state.remotePublicKey) return;

  const remoteKey = await importPublicKey(fromBase64(state.remotePublicKey));
  const pair = await generateDhKeyPair();
  const stepped = await rootStep(
    fromBase64(state.rootKey),
    await dh(pair.privateKey, remoteKey),
  );

  state.rootKey = toBase64(stepped.rootKey);
  state.sendChainKey = toBase64(stepped.chainKey);
  state.sendingPrivateKey = toBase64(await exportPrivateKey(pair.privateKey));
  state.sendingPublicKey = toBase64(await exportPublicKey(pair.publicKey));
  state.previousSendingLength = state.sendMessageNumber;
  state.sendMessageNumber = 0;
  state.sendRatchetPending = false;
}

export async function encryptDm(
  sessionId: string,
  recipientDeviceId: string,
  plaintext: string,
): Promise<RatchetEnvelope> {
  const state = await readState(sessionId);
  if (!state) throw new Error('Ratchet session is not initialized');

  if (state.sendRatchetPending) {
    await performSendingRatchet(state);
  }

  const header: RatchetHeader = {
    v: PROTOCOL_VERSION,
    dh: state.sendingPublicKey,
    n: state.sendMessageNumber,
    pn: state.previousSendingLength,
  };
  const step = await chainStep(fromBase64(state.sendChainKey));
  const encrypted = await encryptWithKey(step.messageKey, plaintext, headerBytes(header));

  state.sendChainKey = toBase64(step.nextChainKey);
  state.sendMessageNumber += 1;
  state.updatedAt = Date.now();
  await writeState(state);

  return {
    recipientDeviceId,
    ciphertext: JSON.stringify({
      v: PROTOCOL_VERSION,
      h: header,
      c: toBase64(encrypted),
    }),
  };
}

export async function decryptDm(sessionId: string, ciphertext: string): Promise<string> {
  const state = await readState(sessionId);
  if (!state) throw new Error('Ratchet session is not initialized');

  let envelope: { v: number; h: RatchetHeader; c: string };
  try {
    envelope = JSON.parse(ciphertext) as { v: number; h: RatchetHeader; c: string };
  } catch {
    throw new Error('Invalid ratchet envelope');
  }

  if (
    envelope.v !== PROTOCOL_VERSION ||
    !envelope.h ||
    typeof envelope.h.dh !== 'string' ||
    !Number.isInteger(envelope.h.n) ||
    !Number.isInteger(envelope.h.pn) ||
    typeof envelope.c !== 'string'
  ) {
    throw new Error('Unsupported ratchet envelope');
  }
  if (envelope.h.n !== state.receiveMessageNumber) {
    throw new Error('Out-of-order ratchet messages are not supported');
  }

  const isFirstPeerMessage = !state.remotePublicKey;
  const peerChanged =
    !isFirstPeerMessage && envelope.h.dh !== state.remotePublicKey;

  if (peerChanged) {
    const privateKey = await importPrivateKey(fromBase64(state.sendingPrivateKey));
    const peerKey = await importPublicKey(fromBase64(envelope.h.dh));
    const stepped = await rootStep(
      fromBase64(state.rootKey),
      await dh(privateKey, peerKey),
    );
    state.rootKey = toBase64(stepped.rootKey);
    state.receiveChainKey = toBase64(stepped.chainKey);
    state.receiveMessageNumber = 0;
    state.remotePublicKey = envelope.h.dh;
    state.sendRatchetPending = true;
  } else if (isFirstPeerMessage) {
    state.remotePublicKey = envelope.h.dh;
    state.sendRatchetPending = true;
  }

  const step = await chainStep(fromBase64(state.receiveChainKey));
  const plaintext = await decryptWithKey(
    step.messageKey,
    fromBase64(envelope.c),
    headerBytes(envelope.h),
  );

  state.receiveChainKey = toBase64(step.nextChainKey);
  state.receiveMessageNumber += 1;
  state.updatedAt = Date.now();
  await writeState(state);
  return plaintext;
}
