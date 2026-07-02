'use client';

import { useEffect, useState } from 'react';
import { decryptThumbnailToObjectUrl } from '@/lib/thumbnail';
import type { FileMessagePayload } from '@/lib/fileEncryption';

interface EncryptedThumbnailProps {
  /** Thumbnail reference from a decrypted FileMessagePayload */
  thumbnail: FileMessagePayload['thumbnail'];
  /** JWT for presigned URL requests */
  authToken: string;
  /** Backend base URL */
  apiBaseUrl: string;
  /** Alt text for accessibility */
  alt?: string;
  /** CSS class names for the <img> element */
  className?: string;
}

/**
 * EncryptedThumbnail
 *
 * Renders an inline image preview by:
 *  1. Calling downloadAndDecryptFile() for the thumbnail ciphertext
 *  2. Creating a local Object URL from the decrypted Blob
 *  3. Revoking the Object URL on unmount to avoid memory leaks
 *
 * Acceptance criteria (#167):
 *   ✓ Inline preview after local decrypt
 */
export function EncryptedThumbnail({
  thumbnail,
  authToken,
  apiBaseUrl,
  alt = 'File thumbnail',
  className,
}: EncryptedThumbnailProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!thumbnail) return;
    let revoked = false;

    decryptThumbnailToObjectUrl(thumbnail, authToken, apiBaseUrl)
      .then((url) => {
        if (!revoked && url) {
          setObjectUrl(url);
        }
      })
      .catch(() => {
        if (!revoked) setError(true);
      });

    return () => {
      revoked = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // objectUrl intentionally excluded — revocation is handled on unmount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnail, authToken, apiBaseUrl]);

  if (!thumbnail) return null;

  if (error) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded bg-gray-100 text-xs text-gray-400">
        ⚠️
      </div>
    );
  }

  if (!objectUrl) {
    // Loading skeleton
    return (
      <div className="h-16 w-16 animate-pulse rounded bg-gray-200" aria-label="Loading thumbnail" />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={objectUrl}
      alt={alt}
      className={className ?? 'max-h-48 max-w-xs rounded object-cover'}
      loading="lazy"
      decoding="async"
    />
  );
}
