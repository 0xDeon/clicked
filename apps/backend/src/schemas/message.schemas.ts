import { z } from 'zod';

/**
 * Zod schema for the REST POST /messages send path.
 * Mirrors the content-type rules enforced by `validateMessagePayload`.
 *
 * Note: content-type-specific field requirements (fileId, envelopes) are
 * validated at the validator layer rather than the Zod layer so that the same
 * logic is reused by the WebSocket handler without duplicating discriminated-
 * union schemas.
 */

export const EnvelopeSchema = z.object({
  recipientDeviceId: z.string().uuid('recipientDeviceId must be a valid UUID'),
  ciphertext: z.string().min(1, 'envelope ciphertext is required'),
});

export const SendMessageSchema = z.object({
  conversationId: z.string().uuid('conversationId must be a valid UUID'),
  messageId: z.string().uuid('messageId must be a valid UUID'),
  contentType: z.string().trim().toLowerCase().optional().default('text'),
  ciphertext: z.string().optional(),
  envelopes: z.array(EnvelopeSchema).optional(),
  /** UUID of an already-uploaded file; required when contentType is file/image/video/audio */
  fileId: z.string().uuid('fileId must be a valid UUID').optional(),
});

export type SendMessageBody = z.infer<typeof SendMessageSchema>;
export type EnvelopeBody = z.infer<typeof EnvelopeSchema>;
