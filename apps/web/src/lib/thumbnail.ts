/**
 * thumbnail.ts — Client-side thumbnail generation + encryption (web)
 *
 * For image and video file attachments, this module:
 *  1. Generates a thumbnail entirely in the browser (Canvas / VideoElement)
 *  2. Encrypts the thumbnail as its own file (#167) via fileEncryption.ts
 *  3. Uploads the encrypted thumbnail ciphertext to S3
 *  4. Returns a thumbnail reference { fileId, fileKey, iv, mimeType } for
 *     embedding in the parent FileMessagePayload
 *
 * The parent message payload (and thus the thumbnail reference) is then itself
 * encrypted into per-device envelopes — so the thumbnail key is never on the wire
 * in the clear.
 *
 * Rendering: after decrypting the parent envelope, clients extract the thumbnail
 * reference, call downloadAndDecryptFile() for the thumbnail fileId, and create
 * an Object URL for inline preview.
 *
 * Acceptance criteria (#167):
 *   ✓ Thumbnails generated + encrypted client-side
 *   ✓ Embedded by reference in the file message (fileId + key + iv)
 *   ✓ Inline preview rendered after local decrypt
 */

import {
  encryptFile,
  uploadCiphertextToS3,
  requestPresignedUpload,
  downloadAndDecryptFile,
  type FileMessagePayload,
} from './fileEncryption.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum edge length (px) for generated thumbnails */
const THUMBNAIL_MAX_EDGE = 320;

/** JPEG quality for image thumbnails (0–1) */
const THUMBNAIL_JPEG_QUALITY = 0.8;

/** Thumbnail MIME type */
const THUMBNAIL_MIME = 'image/jpeg';

/** Maximum video duration (seconds) to seek for thumbnail frame */
const VIDEO_SEEK_SECONDS = 2;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ThumbnailReference {
  /** UUID of the encrypted thumbnail file in S3 */
  fileId: string;
  /** Base64 AES-256-GCM key for the thumbnail (goes inside E2EE envelopes only) */
  fileKey: string;
  /** Base64 IV */
  iv: string;
  mimeType: string;
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

/**
 * Scale dimensions down so neither edge exceeds THUMBNAIL_MAX_EDGE,
 * preserving aspect ratio.
 */
function scaleDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  if (width <= THUMBNAIL_MAX_EDGE && height <= THUMBNAIL_MAX_EDGE) {
    return { width, height };
  }
  const ratio = Math.min(THUMBNAIL_MAX_EDGE / width, THUMBNAIL_MAX_EDGE / height);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/**
 * Draw an HTMLImageElement or HTMLVideoElement onto a canvas and export as JPEG Blob.
 */
function canvasToBlob(
  source: HTMLImageElement | HTMLVideoElement,
  naturalWidth: number,
  naturalHeight: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const { width, height } = scaleDimensions(naturalWidth, naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Failed to get 2D canvas context'));
      return;
    }

    ctx.drawImage(source, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas toBlob returned null'));
        }
      },
      THUMBNAIL_MIME,
      THUMBNAIL_JPEG_QUALITY,
    );
  });
}

// ─── Thumbnail generation ─────────────────────────────────────────────────────

/**
 * Generate a thumbnail for an image File.
 * Returns a JPEG Blob of at most THUMBNAIL_MAX_EDGE × THUMBNAIL_MAX_EDGE.
 */
export function generateImageThumbnail(imageFile: File | Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(imageFile);
    const img = new Image();

    img.onload = () => {
      canvasToBlob(img, img.naturalWidth, img.naturalHeight)
        .then(resolve)
        .catch(reject)
        .finally(() => URL.revokeObjectURL(url));
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for thumbnail generation'));
    };

    img.src = url;
  });
}

/**
 * Generate a thumbnail for a video File by seeking to VIDEO_SEEK_SECONDS.
 * Falls back to the first decodable frame if the seek fails.
 */
export function generateVideoThumbnail(videoFile: File | Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(videoFile);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';

    video.onloadeddata = () => {
      // Seek to a specific time to get a meaningful frame
      video.currentTime = Math.min(VIDEO_SEEK_SECONDS, video.duration || VIDEO_SEEK_SECONDS);
    };

    video.onseeked = () => {
      canvasToBlob(video, video.videoWidth, video.videoHeight)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          URL.revokeObjectURL(url);
          video.src = '';
        });
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load video for thumbnail generation'));
    };

    video.src = url;
  });
}

// ─── Full encrypted thumbnail pipeline (#167) ─────────────────────────────────

export interface GenerateEncryptedThumbnailParams {
  file: File;
  authToken: string;
  apiBaseUrl: string;
}

/**
 * Generate + encrypt a thumbnail for an image or video file (#167).
 *
 * Pipeline:
 *  1. Generate thumbnail Blob client-side (Canvas)
 *  2. Encrypt thumbnail with a fresh AES-256-GCM key (encryptFile)
 *  3. Request presigned PUT from backend
 *  4. Upload ciphertext to S3
 *  5. Return ThumbnailReference { fileId, fileKey, iv, mimeType }
 *
 * The returned ThumbnailReference is embedded in the parent FileMessagePayload
 * and encrypted into per-device envelopes — the thumbnail key never appears
 * on the wire in plaintext.
 *
 * Returns null for unsupported MIME types (non-image, non-video).
 */
export async function generateEncryptedThumbnail(
  params: GenerateEncryptedThumbnailParams,
): Promise<ThumbnailReference | null> {
  const { file, authToken, apiBaseUrl } = params;

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (!isImage && !isVideo) {
    return null;
  }

  // Step 1: Generate thumbnail Blob
  let thumbnailBlob: Blob;
  try {
    if (isImage) {
      thumbnailBlob = await generateImageThumbnail(file);
    } else {
      thumbnailBlob = await generateVideoThumbnail(file);
    }
  } catch (err) {
    // Thumbnail generation is best-effort — log and continue without thumbnail
    console.warn('[thumbnail] Failed to generate thumbnail:', err);
    return null;
  }

  // Step 2: Encrypt thumbnail (AES-256-GCM, fresh key per thumbnail)
  const { cipherBlob, fileKeyB64, ivB64 } = await encryptFile(thumbnailBlob);

  // Step 3: Request presigned PUT URL for the thumbnail
  const { fileId, uploadUrl } = await requestPresignedUpload(
    `thumbnail-${file.name}.jpg`,
    THUMBNAIL_MIME,
    thumbnailBlob.size,
    authToken,
    apiBaseUrl,
  );

  // Step 4: Upload encrypted thumbnail ciphertext
  await uploadCiphertextToS3(uploadUrl, cipherBlob);

  // Step 5: Return reference for embedding in parent FileMessagePayload
  return {
    fileId,
    fileKey: fileKeyB64,
    iv: ivB64,
    mimeType: THUMBNAIL_MIME,
  };
}

// ─── Inline preview rendering ─────────────────────────────────────────────────

/**
 * Decrypt a thumbnail and return an Object URL for use as an `<img src>`.
 * Callers MUST call URL.revokeObjectURL() when the component unmounts.
 *
 * @param thumbnail ThumbnailReference from a decrypted FileMessagePayload
 */
export async function decryptThumbnailToObjectUrl(
  thumbnail: FileMessagePayload['thumbnail'],
  authToken: string,
  apiBaseUrl: string,
): Promise<string | null> {
  if (!thumbnail) return null;

  try {
    const plainBlob = await downloadAndDecryptFile(
      thumbnail.fileId,
      thumbnail.fileKey,
      thumbnail.iv,
      thumbnail.mimeType,
      authToken,
      apiBaseUrl,
    );
    return URL.createObjectURL(plainBlob);
  } catch (err) {
    console.warn('[thumbnail] Failed to decrypt thumbnail:', err);
    return null;
  }
}
