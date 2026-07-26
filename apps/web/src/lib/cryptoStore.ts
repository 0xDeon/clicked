class CryptoStore {
  private dbName = 'clicked_crypto';
  private dbVersion = 2; // Incremented for identity key storage upgrade
  private db: IDBDatabase | null = null;

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
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys');
        }
        if (!db.objectStoreNames.contains('deviceId')) {
          db.createObjectStore('deviceId');
        }
        // Version 2: Add identityKeyPair store for structured CryptoKey persistence
        if (event.oldVersion < 2 && !db.objectStoreNames.contains('identityKeyPair')) {
          db.createObjectStore('identityKeyPair');
        }
      };
    });
  }

  private dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T);
    });
  }

  private dbPut<T>(storeName: string, value: T, key?: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = key ? store.put(value, key) : store.put(value);

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
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

  private generateDeviceId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return `device_${timestamp}_${random}`;
  }

  async getOrCreateDeviceId(): Promise<string> {
    const existingId = await this.dbGet<string>('deviceId', 'id');
    if (existingId) return existingId;

    const newId = this.generateDeviceId();
    await this.dbPut('deviceId', newId, 'id');
    return newId;
  }

  /**
   * Generate a new identity keypair with extractable=true for private key persistence.
   * The private CryptoKey is stored via IndexedDB structured clone (no export required).
   */
  async generateIdentityKeyPair(): Promise<CryptoKeyPair> {
    const keyPair = (await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true, // extractable=true for private key (allows structured clone storage)
      ['deriveKey', 'deriveBits'],
    )) as CryptoKeyPair;

    return keyPair;
  }

  /**
   * Persist the identity keypair using IndexedDB structured clone.
   * Stores both the full CryptoKeyPair and the exported public JWK for compatibility.
   */
  async storeIdentityKeyPair(keyPair: CryptoKeyPair): Promise<void> {
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    // Store full CryptoKeyPair via structured clone (no export needed for private key)
    await this.dbPut(
      'identityKeyPair',
      {
        keyPair, // IndexedDB can serialize CryptoKey objects directly
        createdAt: Date.now(),
      },
      'current',
    );

    // Maintain legacy public key storage for backwards compatibility
    await this.dbPut(
      'keys',
      {
        id: 'identity_keypair',
        publicKey: publicKeyJwk,
        createdAt: Date.now(),
      },
      'identity_keypair',
    );
  }

  /**
   * Retrieve the persisted identity private key.
   * Returns the same CryptoKey across page reloads, preserving identity continuity.
   */
  async getIdentityPrivateKey(): Promise<CryptoKey | null> {
    const stored = await this.dbGet<{ keyPair: CryptoKeyPair; createdAt: number }>(
      'identityKeyPair',
      'current',
    );
    
    if (stored?.keyPair?.privateKey) {
      return stored.keyPair.privateKey;
    }

    // Fallback: check if we have legacy data (migration path)
    const legacyKey = await this.dbGet<{ id: string; publicKey: JsonWebKey; createdAt: number }>(
      'keys',
      'identity_keypair',
    );
    
    if (!legacyKey) {
      return null;
    }

    // Legacy data exists but no CryptoKey — identity was lost, must regenerate
    console.warn('Identity private key was not persisted. Regenerating identity keypair.');
    return null;
  }

  async getIdentityPublicKey(): Promise<JsonWebKey | null> {
    const keyData = await this.dbGet<{ id: string; publicKey: JsonWebKey; createdAt: number }>(
      'keys',
      'identity_keypair',
    );
    if (!keyData) return null;
    return keyData.publicKey;
  }

  /**
   * Initialize or retrieve the identity key, ensuring the private key is persisted.
   */
  async initializeIdentityKey(): Promise<JsonWebKey> {
    // Check if we have a persisted keypair
    const stored = await this.dbGet<{ keyPair: CryptoKeyPair; createdAt: number }>(
      'identityKeyPair',
      'current',
    );

    if (stored?.keyPair?.privateKey) {
      // Identity exists and private key is persisted
      const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', stored.keyPair.publicKey);
      return publicKeyJwk;
    }

    // No persisted keypair — generate and store new identity
    const keyPair = await this.generateIdentityKeyPair();
    await this.storeIdentityKeyPair(keyPair);

    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
    return publicKeyJwk;
  }

  async getDeviceInfo(): Promise<{ deviceId: string; publicKey: JsonWebKey }> {
    const deviceId = await this.getOrCreateDeviceId();
    const publicKey = await this.initializeIdentityKey();

    if (!publicKey) {
      throw new Error('Failed to initialize identity key');
    }

    return { deviceId, publicKey };
  }

  async clear(): Promise<void> {
    await this.dbClear('keys');
    await this.dbClear('deviceId');
    await this.dbClear('identityKeyPair');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const cryptoStore = new CryptoStore();
