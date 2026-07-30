/**
 * MLS transport primitives.
 *
 * The backend deliberately does not parse, decrypt, or persist MLS group
 * state. Welcome values are opaque client-generated ciphertext and are only
 * identified by their transport content type.
 */

export const MLS_WELCOME_CONTENT_TYPE = 'application/mls-welcome';
export const MLS_WELCOME_EVENT = 'mls_welcome';

/**
 * Returns true when a message is an MLS Welcome transport message.
 */
export function isMlsWelcomeContentType(contentType: string | null | undefined): boolean {
  return contentType?.trim().toLowerCase() === MLS_WELCOME_CONTENT_TYPE;
}

/**
 * Transport metadata attached to device-scoped delivery events. The Welcome
 * itself remains an opaque string and is never decoded by the backend.
 */
export type MlsWelcomeTransport = {
  eventType: typeof MLS_WELCOME_EVENT;
  contentType: typeof MLS_WELCOME_CONTENT_TYPE;
};

export function mlsWelcomeTransport(): MlsWelcomeTransport {
  return {
    eventType: MLS_WELCOME_EVENT,
    contentType: MLS_WELCOME_CONTENT_TYPE,
  };
}
