import { z } from 'zod';
import { BASELINE_PROTOCOL, KNOWN_PROTOCOLS } from '../lib/capabilities.js';

/**
 * Zod schema for the REST POST /messages send path.
 * Mirrors the content-type rules enforced by `validateMessagePayload`.
 *
 * Message content is ciphertext only. `.strict()` is intentional: accepting
 * and silently stripping an unknown `content`, key, or ratchet field would
 * make it possible for a plaintext/secret upload path to reappear unnoticed.
 */

// `.strict()` on both schemas: a message envelope only ever carries a
// recipient device id, opaque ciphertext, and the name of the construction
// that produced it. An unrecognized field (e.g. a client attaching
// `ratchetState` or `privateKey`) must fail validation (400) instead of being
// silently stripped — the server never stores or relays Signal
// session/ratchet/private-key state.
export const EnvelopeSchema = z
  .object({
    recipientDeviceId: z.string().uuid('recipientDeviceId must be a valid UUID'),
    ciphertext: z.string().min(1, 'envelope ciphertext is required'),
    /**
     * Which construction produced `ciphertext` (#364). Defaults to the Phase-1
     * sealed box so clients that predate the migration keep working unchanged.
     * Must be a protocol the recipient device advertises in its capabilities,
     * and may not downgrade below what both devices support — enforced in
     * services/e2eeProtocol.ts.
     */
    protocol: z.enum(KNOWN_PROTOCOLS).optional().default(BASELINE_PROTOCOL),
  })
  .strict();

export const SendMessageSchema = z
  .object({
    conversationId: z.string().uuid('conversationId must be a valid UUID'),
    messageId: z.string().uuid('messageId must be a valid UUID'),
    contentType: z.string().trim().toLowerCase().optional().default('text'),
    ciphertext: z.string().min(1, 'ciphertext is required').optional(),
    envelopes: z.array(EnvelopeSchema).optional(),
    /** UUID of an already-uploaded file; required when contentType is file/image/video/audio */
    fileId: z.string().uuid('fileId must be a valid UUID').optional(),
    /**
     * MLS epoch whose secrets encrypted `ciphertext` (#372). Present only on MLS
     * group messages, which carry one group ciphertext instead of per-device
     * envelopes. Recorded so the history read paths know which devices can
     * derive the key.
     */
    mlsEpoch: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SendMessageBody = z.infer<typeof SendMessageSchema>;
export type EnvelopeBody = z.infer<typeof EnvelopeSchema>;
