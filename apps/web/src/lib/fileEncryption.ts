/**
 * fileEncryption.ts — Client-side file encryption/decryption (web)
 *
 * Implements the full file E2EE flow:
 *
 *  UPLOAD PATH (#163 / #164 / #165)
 *   1. Generate a random 256-bit AES-GCM file key
 *   2. Encrypt the file bytes with that key → ciphertext blob
 *   3. Upload ciphertext to S3 via presigned PUT (#164)
 *   4. Build the file message payload { fileId, fileName, mimeType, size, fileKey, thumbnail? }
 *   5. Encrypt the payload into per-device envelopes (#165) via buildEnvelopes()
 *
 *  DOWNLOAD PATH (#166)
 *   1. Fetch presigned GET URL from backend
 *   2. Download ciphertext blob
 *   3. Decrypt with the file key extracted from the device envelope
 *   4. Verify AES-GCM AEAD tag (implicit in SubtleCrypto decrypt)
 *
 * Acceptance criteria:
 *   ✓ Files encrypted before upload; only ciphertext leaves the browser
 *   ✓ File key transmitted only inside E2EE envelopes (never in the clear)
 *   ✓ Download path decrypts + verifies AEAD tag
 */

import { buildEnvelopes, type DeviceRecord, type MessageEnvelope } from './crypto.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EncryptedFileResult {
  /** The encrypted file bytes (ciphertext + GCM tag) */
  cipherBlob: Blob;
  /** Base64-encoded 256-bit AES-GCM key (NEVER sent in plaintext) */
  fileKeyB64: string;
  /** Base64-encoded 96-bit IV used for encryption */
  ivB64: string;
}

export interface FileMessagePayload {
  /** UUID assigned by the backend after upload */
  fileId: string;
  fileName: string;
  mimeType: string;
  /** Original plaintext byte length */
  size: number;
  /** Base64-encoded AES-GCM file key — must be inside E2EE envelopes only */
  fileKey: string;
  /** Base64-encoded IV */
  iv: string;
  /** Optional thumbnail reference (set by generateEncryptedThumbnail) */
  thumbnail?: {
    fileId: string;
    fileKey: string;
    iv: string;
    mimeType: string;
  };
}

export interface PresignedUploadResponse {
  /** Backend-assigned UUID for this file */
  fileId: string;
  /** S3 presigned PUT URL */
  uploadUrl: string;
}

export interface PresignedDownloadResponse {
  /** S3 presigned GET URL */
  url: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Key management ───────────────────────────────────────────────────────────

/**
 * Generate a random 256-bit AES-GCM key.
 * Returns both the exportable CryptoKey and its base64 representation.
 */
export async function generateFileKey(): Promise<{ key: CryptoKey; keyB64: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { key, keyB64: bytesToB64(rawKey) };
}

/**
 * Import a base64 AES-GCM key for decryption.
 */
export async function importFileKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'decrypt',
  ]);
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt a File or Blob with AES-256-GCM.
 *
 * The AES-GCM tag (16 bytes) is appended to the ciphertext by SubtleCrypto.
 * Only the encrypted bytes leave this function — the key stays in memory.
 */
export async function encryptFile(file: File | Blob): Promise<EncryptedFileResult> {
  const { key, keyB64 } = await generateFileKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const plainBytes = new Uint8Array(await file.arrayBuffer());
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);

  return {
    cipherBlob: new Blob([cipherBuf], { type: 'application/octet-stream' }),
    fileKeyB64: keyB64,
    ivB64: bytesToB64(iv),
  };
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * Request a presigned PUT URL from the backend (#164).
 */
export async function requestPresignedUpload(
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  authToken: string,
  apiBaseUrl: string,
): Promise<PresignedUploadResponse> {
  const resp = await fetch(`${apiBaseUrl}/files/presign-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ fileName, mimeType, sizeBytes }),
  });

  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Presign upload failed: ${resp.status}`);
  }

  return resp.json() as Promise<PresignedUploadResponse>;
}

/**
 * PUT the encrypted ciphertext to S3 via a presigned URL (#163).
 * Only ciphertext bytes are transmitted; the key is never part of this request.
 */
export async function uploadCiphertextToS3(
  presignedUrl: string,
  cipherBlob: Blob,
): Promise<void> {
  const resp = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: cipherBlob,
  });

  if (!resp.ok) {
    throw new Error(`S3 upload failed: ${resp.status}`);
  }
}

// ─── Full file send pipeline ──────────────────────────────────────────────────

export interface SendFileParams {
  file: File;
  conversationId: string;
  messageId: string;
  devices: DeviceRecord[];
  /** Optional pre-encrypted thumbnail to embed in the payload */
  thumbnail?: FileMessagePayload['thumbnail'];
  authToken: string;
  apiBaseUrl: string;
}

export interface SendFileResult {
  fileId: string;
  envelopes: MessageEnvelope[];
  payload: FileMessagePayload;
}

/**
 * Full file send pipeline (#165):
 *  1. Encrypt the file client-side (AES-256-GCM)
 *  2. Upload ciphertext to S3 via presigned PUT
 *  3. Build FileMessagePayload (fileId, fileName, mimeType, size, fileKey, iv, thumbnail?)
 *  4. Serialize the payload to JSON and encrypt into per-device envelopes
 *
 * The file key is ONLY transmitted inside the E2EE envelopes — never in plain.
 */
export async function sendEncryptedFile(params: SendFileParams): Promise<SendFileResult> {
  const { file, conversationId: _conversationId, messageId: _messageId, devices, thumbnail, authToken, apiBaseUrl } =
    params;

  // Step 1: Encrypt
  const { cipherBlob, fileKeyB64, ivB64 } = await encryptFile(file);

  // Step 2: Request presigned URL + upload
  const { fileId, uploadUrl } = await requestPresignedUpload(
    file.name,
    file.type,
    file.size,
    authToken,
    apiBaseUrl,
  );
  await uploadCiphertextToS3(uploadUrl, cipherBlob);

  // Step 3: Build payload (file key embedded — to be encrypted into envelopes)
  const payload: FileMessagePayload = {
    fileId,
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
    fileKey: fileKeyB64,
    iv: ivB64,
    ...(thumbnail ? { thumbnail } : {}),
  };

  // Step 4: Encrypt payload into per-device envelopes (#165)
  // The JSON string carrying fileKey is never transmitted in the clear.
  const payloadJson = JSON.stringify(payload);
  const envelopes = await buildEnvelopes(payloadJson, devices);

  return { fileId, envelopes, payload };
}

// ─── Download + decrypt (#166) ────────────────────────────────────────────────

/**
 * Fetch a presigned GET URL from the backend for a given fileId (#166).
 */
export async function fetchPresignedDownload(
  fileId: string,
  authToken: string,
  apiBaseUrl: string,
): Promise<string> {
  const resp = await fetch(`${apiBaseUrl}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Fetch presigned download failed: ${resp.status}`);
  }

  const data = (await resp.json()) as PresignedDownloadResponse;
  return data.url;
}

/**
 * Download + decrypt a file (#166).
 *
 * @param fileId     UUID of the file to download
 * @param fileKeyB64 Base64 AES-GCM key extracted from the device envelope
 * @param ivB64      Base64 IV extracted from the device envelope payload
 * @param mimeType   Original MIME type for the returned Blob
 *
 * AES-GCM authentication tag verification is implicit: SubtleCrypto.decrypt()
 * throws a DOMException if the tag is invalid — the AEAD guarantee.
 */
export async function downloadAndDecryptFile(
  fileId: string,
  fileKeyB64: string,
  ivB64: string,
  mimeType: string,
  authToken: string,
  apiBaseUrl: string,
): Promise<Blob> {
  // 1. Get presigned download URL
  const downloadUrl = await fetchPresignedDownload(fileId, authToken, apiBaseUrl);

  // 2. Download ciphertext
  const cipherResp = await fetch(downloadUrl);
  if (!cipherResp.ok) {
    throw new Error(`S3 download failed: ${cipherResp.status}`);
  }
  const cipherBytes = new Uint8Array(await cipherResp.arrayBuffer());

  // 3. Decrypt + verify AEAD tag (SubtleCrypto throws on tag mismatch)
  const key = await importFileKey(fileKeyB64);
  const iv = b64ToBytes(ivB64);

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
  } catch {
    throw new Error('File decryption failed: authentication tag mismatch or corrupted data');
  }

  return new Blob([plainBuf], { type: mimeType });
}

/**
 * Convenience: decode a FileMessagePayload JSON from an envelope ciphertext.
 * Callers pass the plaintext string after decrypting their own envelope.
 */
export function parseFileMessagePayload(envelopePlaintext: string): FileMessagePayload {
  const payload = JSON.parse(envelopePlaintext) as FileMessagePayload;

  if (!payload.fileId || !payload.fileKey || !payload.iv) {
    throw new Error('Invalid FileMessagePayload: missing required fields');
  }

  return payload;
}
