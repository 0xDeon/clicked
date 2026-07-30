/**
 * Structured logging for the encrypted pipeline (#393).
 *
 * Redact paths cover the field names that could carry ciphertext or
 * envelope payloads if a caller accidentally logs a whole object; callers
 * should still only pass metadata (ids, counts, durations) — redaction is
 * a backstop, not the primary guarantee.
 */
import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'ciphertext',
      '*.ciphertext',
      'envelopes',
      '*.envelopes',
      'payload',
      '*.payload',
      'plaintext',
      '*.plaintext',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'clicked-backend' },
});
