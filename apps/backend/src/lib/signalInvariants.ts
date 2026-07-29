/**
 * Signal-protocol invariants the server must uphold.
 *
 * The server is a dumb relay for ciphertext and public key material only:
 * it must never accept, store, or relay Double-Ratchet session state,
 * chain/root keys, or private key halves — every client re-derives its own
 * session state locally and only ever needs to exchange public material and
 * opaque ciphertext through us.
 *
 * REST endpoints get this for free via `.strict()` on their Zod schemas
 * (unknown keys fail validation -> 400, see schemas/auth.schemas.ts,
 * schemas/message.schemas.ts and lib/keys.ts). The WebSocket `send_message` /
 * `edit_message` handlers parse payloads by hand rather than through Zod, so
 * `findForbiddenSessionStateField` guards those paths explicitly.
 */

export const FORBIDDEN_SESSION_STATE_FIELDS = [
  'sessionState',
  'ratchetState',
  'rootKey',
  'chainKey',
  'senderKey',
  'privateKey',
  'identityPrivateKey',
  'signedPreKeyPrivate',
  'oneTimePreKeyPrivate',
] as const;

export type ForbiddenSessionStateField = (typeof FORBIDDEN_SESSION_STATE_FIELDS)[number];

/**
 * Returns the name of the first forbidden session/private-key field found on
 * `payload` (or any of its `envelopes` entries), or `null` if none are
 * present. Only checks own-enumerable keys — inherited/prototype properties
 * are not user-controlled input.
 */
export function findForbiddenSessionStateField(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload || typeof payload !== 'object') return null;

  for (const field of FORBIDDEN_SESSION_STATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) return field;
  }

  const envelopes = (payload as { envelopes?: unknown }).envelopes;
  if (Array.isArray(envelopes)) {
    for (const envelope of envelopes) {
      if (!envelope || typeof envelope !== 'object') continue;
      for (const field of FORBIDDEN_SESSION_STATE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(envelope, field)) return field;
      }
    }
  }

  return null;
}
