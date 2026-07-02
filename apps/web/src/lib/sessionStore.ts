import { apiFetch } from './api';
import { prekeyStore } from './prekeyStore';

interface DeviceBundle {
  deviceId: string;
  identityKey: JsonWebKey;
  signedPrekey: {
    keyId: string;
    publicKey: JsonWebKey;
    signature: string;
  };
  oneTimePrekey: {
    keyId: string;
    publicKey: JsonWebKey;
  } | null;
}

interface SessionData {
  sessionId: string;
  deviceId: string;
  sharedSecret: CryptoKey;
  createdAt: number;
}

interface CachedSession {
  sessionId: string;
  deviceId: string;
  sharedSecretJwk: JsonWebKey;
  createdAt: number;
}

interface SessionProtocol {
  deriveSharedSecret(publicKey1: JsonWebKey, publicKey2: JsonWebKey): Promise<CryptoKey>;
  encryptMessage(message: string, sharedSecret: CryptoKey): Promise<{ ciphertext: string; iv: string }>;
  decryptMessage(ciphertext: string, iv: string, sharedSecret: CryptoKey): Promise<string>;
}

class SealedBoxProtocol implements SessionProtocol {
  async deriveSharedSecret(publicKey1: JsonWebKey, publicKey2: JsonWebKey): Promise<CryptoKey> {
    const importedKey1 = await window.crypto.subtle.importKey(
      'jwk',
      publicKey1,
      {
        name: 'ECDH',
        namedCurve: 'X25519',
      },
      false,
      ['deriveBits'],
    );

    const importedKey2 = await window.crypto.subtle.importKey(
      'jwk',
      publicKey2,
      {
        name: 'ECDH',
        namedCurve: 'X25519',
      },
      false,
      ['deriveBits'],
    );

    const sharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedKey2 },
      importedKey1,
      256,
    );

    const sharedSecret = await window.crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    return sharedSecret;
  }

  async encryptMessage(message: string, sharedSecret: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(message);

    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sharedSecret,
      encoded,
    );

    return {
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      ciphertext: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join(''),
    };
  }

  async decryptMessage(ciphertext: string, iv: string, sharedSecret: CryptoKey): Promise<string> {
    const ivBytes = new Uint8Array(
      iv.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );
    const ciphertextBytes = new Uint8Array(
      ciphertext.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      sharedSecret,
      ciphertextBytes,
    );

    return new TextDecoder().decode(decrypted);
  }
}

class SessionStore {
  private dbName = 'clicked_sessions';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private protocol: SessionProtocol = new SealedBoxProtocol();

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          store.createIndex('deviceId', 'deviceId', { unique: true });
        }
      };
    });
  }

  private dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T);
    });
  }

  private dbGetByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T | undefined> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T);
    });
  }

  private dbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(value);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  private dbClear(storeName: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async verifySignedPrekeySignature(
    signature: string,
    publicKey: JsonWebKey,
    identityKey: JsonWebKey,
  ): Promise<boolean> {
    try {
      const importedKey = await window.crypto.subtle.importKey(
        'jwk',
        identityKey,
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        false,
        ['verify'],
      );

      const publicKeyData = JSON.stringify(publicKey);
      const data = new TextEncoder().encode(publicKeyData);
      const signatureBytes = new Uint8Array(
        signature.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
      );

      const isValid = await window.crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: 'SHA-256',
        },
        importedKey,
        signatureBytes,
        data,
      );

      return isValid;
    } catch {
      return false;
    }
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  async fetchDeviceBundle(recipientId: string, deviceId: string, token: string): Promise<DeviceBundle> {
    const response = await apiFetch(`/crypto/bundles/${recipientId}/${deviceId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch device bundle');
    }

    return response.json();
  }

  async establishSession(
    recipientId: string,
    recipientDeviceId: string,
    token: string,
    myPublicKey: JsonWebKey,
  ): Promise<SessionData> {
    const bundle = await this.fetchDeviceBundle(recipientId, recipientDeviceId, token);

    const isSignatureValid = await this.verifySignedPrekeySignature(
      bundle.signedPrekey.signature,
      bundle.signedPrekey.publicKey,
      bundle.identityKey,
    );

    if (!isSignatureValid) {
      throw new Error('Invalid signed prekey signature');
    }

    const selectedPrekeyPublicKey = bundle.oneTimePrekey?.publicKey || bundle.signedPrekey.publicKey;

    const sharedSecret = await this.protocol.deriveSharedSecret(myPublicKey, selectedPrekeyPublicKey);

    const sessionId = this.generateSessionId();
    const cachedSession: CachedSession = {
      sessionId,
      deviceId: bundle.deviceId,
      sharedSecretJwk: await window.crypto.subtle.exportKey('jwk', sharedSecret),
      createdAt: Date.now(),
    };

    await this.dbPut('sessions', cachedSession);

    if (bundle.oneTimePrekey) {
      await prekeyStore.consumeOneTimePrekey(bundle.oneTimePrekey.keyId);
    }

    return {
      sessionId,
      deviceId: bundle.deviceId,
      sharedSecret,
      createdAt: Date.now(),
    };
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const cached = await this.dbGet<CachedSession>('sessions', sessionId);
    if (!cached) return null;

    const sharedSecret = await window.crypto.subtle.importKey(
      'jwk',
      cached.sharedSecretJwk,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    return {
      sessionId: cached.sessionId,
      deviceId: cached.deviceId,
      sharedSecret,
      createdAt: cached.createdAt,
    };
  }

  async getSessionByDeviceId(deviceId: string): Promise<SessionData | null> {
    const cached = await this.dbGetByIndex<CachedSession>('sessions', 'deviceId', deviceId);
    if (!cached) return null;

    const sharedSecret = await window.crypto.subtle.importKey(
      'jwk',
      cached.sharedSecretJwk,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    return {
      sessionId: cached.sessionId,
      deviceId: cached.deviceId,
      sharedSecret,
      createdAt: cached.createdAt,
    };
  }

  setProtocol(protocol: SessionProtocol): void {
    this.protocol = protocol;
  }

  async encryptForSession(sessionId: string, message: string): Promise<{ ciphertext: string; iv: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    return this.protocol.encryptMessage(message, session.sharedSecret);
  }

  async decryptFromSession(sessionId: string, ciphertext: string, iv: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    return this.protocol.decryptMessage(ciphertext, iv, session.sharedSecret);
  }

  async clear(): Promise<void> {
    await this.dbClear('sessions');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const sessionStore = new SessionStore();
export type { SessionProtocol };
