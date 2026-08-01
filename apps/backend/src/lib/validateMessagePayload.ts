/**
 * validateMessagePayload
 *
 * Pure, framework-agnostic validator for the message send path.
 * Called by the WebSocket `send_message` handler and the REST POST /messages
 * endpoint so both paths enforce identical rules.
 *
 * Content-type rules
 * ──────────────────
 * text            – envelopes array must be non-empty (per-recipient encrypted key)
 * file|image|     – fileId must be a non-blank string AND envelopes must be non-empty
 *   video|audio     (the envelope ciphertext carries the encrypted file key)
 * system          – server-generated only; any client submission is rejected (403)
 * <unknown>       – rejected (400)
 *
 * MLS group messages (#372)
 * ─────────────────────────
 * When `mlsEpoch` is present the message is encrypted once to the group's
 * epoch secrets rather than once per recipient device, so the per-device
 * envelope requirement does not apply — a non-empty `ciphertext` is required
 * instead. Sending envelopes alongside `mlsEpoch` is rejected: the two
 * key-distribution models must not be mixed on one message, or recipients have
 * no unambiguous rule for which ciphertext to decrypt.
 */

export interface MessagePayload {
  /** MIME-like content type token, e.g. "text", "image", "file", "system" */
  contentType?: string | undefined;
  /** Base64-encoded ciphertext of the message body (optional for file types) */
  ciphertext?: string | undefined;
  /** Per-recipient E2EE envelopes carrying the encrypted key */
  envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }> | undefined;
  /** UUID referencing the uploaded file (required for file/image/video/audio) */
  fileId?: string | undefined;
  /** MLS epoch that encrypted `ciphertext`; marks this as an MLS group message */
  mlsEpoch?: number | undefined;
}

export type MessagePayloadValidationResult =
  | { ok: true }
  | { ok: false; code: 400 | 403; message: string };

/** All content types clients are allowed to send */
const ALLOWED_CONTENT_TYPES = new Set(['text', 'file', 'image', 'video', 'audio'] as const);

/** Content types that require a fileId + envelopes */
const FILE_CONTENT_TYPES = new Set(['file', 'image', 'video', 'audio'] as const);

/**
 * Validates an inbound message payload for content-type-specific constraints.
 *
 * @returns `{ ok: true }` when the payload is valid, or
 *          `{ ok: false, code, message }` describing the rejection.
 */
export function validateMessagePayload(payload: MessagePayload): MessagePayloadValidationResult {
  // Normalise: trim and lower-case; default to 'text' when absent
  const contentType = (payload.contentType?.trim().toLowerCase() || 'text') as string;

  // ── system messages ──────────────────────────────────────────────────────────
  // Only the server is permitted to create system messages.
  if (contentType === 'system') {
    return {
      ok: false,
      code: 403,
      message: 'system messages are reserved for the server',
    };
  }

  // ── unknown content type ─────────────────────────────────────────────────────
  if (!ALLOWED_CONTENT_TYPES.has(contentType as any)) {
    return {
      ok: false,
      code: 400,
      message: `unsupported contentType: "${contentType}"`,
    };
  }

  const hasEnvelopes = Array.isArray(payload.envelopes) && payload.envelopes.length > 0;

  // ── MLS group message ────────────────────────────────────────────────────────
  // One ciphertext for the whole group; per-device envelopes do not apply.
  if (payload.mlsEpoch !== undefined) {
    if (hasEnvelopes) {
      return {
        ok: false,
        code: 400,
        message: 'MLS group messages carry a single group ciphertext, not per-device envelopes',
      };
    }
    if (!payload.ciphertext?.trim()) {
      return {
        ok: false,
        code: 400,
        message: 'ciphertext is required for MLS group messages',
      };
    }
    if (FILE_CONTENT_TYPES.has(contentType as any) && !payload.fileId?.trim()) {
      return {
        ok: false,
        code: 400,
        message: 'fileId is required for file-type messages',
      };
    }
    return { ok: true };
  }

  // ── file / image / video / audio ─────────────────────────────────────────────
  if (FILE_CONTENT_TYPES.has(contentType as any)) {
    if (!payload.fileId?.trim()) {
      return {
        ok: false,
        code: 400,
        message: 'fileId is required for file-type messages',
      };
    }
    if (!hasEnvelopes) {
      return {
        ok: false,
        code: 400,
        message:
          'envelopes are required for file-type messages (they carry the encrypted file key)',
      };
    }
    return { ok: true };
  }

  // ── text ─────────────────────────────────────────────────────────────────────
  if (!hasEnvelopes) {
    return {
      ok: false,
      code: 400,
      message: 'text messages require at least one envelope with an encrypted key',
    };
  }

  return { ok: true };
}
