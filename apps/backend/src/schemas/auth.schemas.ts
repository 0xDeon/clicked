import { z } from 'zod';
import { IdentityPublicKeySchema } from '../lib/keys.js';
import { DeviceCapabilitiesSchema } from '../lib/capabilities.js';

export const ChallengeSchema = z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
});

export const DeviceSchema = z.object({
  deviceName: z
    .string()
    .min(1, 'deviceName is required')
    .max(100, 'deviceName must be at most 100 characters'),
  platform: z.enum(['web', 'ios', 'android']),
  identityPublicKey: IdentityPublicKeySchema,
  registrationId: z.number().int().nonnegative().optional(),
  // Supported protocols/ciphersuites/file-transfer versions (#180-follow-on).
  // Optional — omitting it defaults to the sealed_box-only baseline so older
  // clients that predate this field keep working unchanged.
  capabilities: DeviceCapabilitiesSchema.optional(),
});

export const VerifySchema = z
  .object({
    walletAddress: z.string().min(1, 'walletAddress is required'),
    signature: z.string().min(1, 'signature is required'),
    nonce: z.string().min(1, 'nonce is required'),
    /**
     * Base64-encoded Ed25519 SPKI DER identity public key (44 bytes).
     * Validated for correct base64 and exact byte length before any crypto operation.
     */
    identityPublicKey: IdentityPublicKeySchema,
    device: DeviceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.device.identityPublicKey !== value.identityPublicKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['device', 'identityPublicKey'],
        message: 'device.identityPublicKey must match identityPublicKey',
      });
    }
  });

/**
 * Body for POST /devices/link/verify (#333).
 *
 * Everything DeviceSchema needs to create the device row, plus the fresh
 * wallet signature over the server-issued device-link nonce. The signature is
 * proof of wallet ownership *now* — the caller's JWT alone is not enough to
 * add a device to an account.
 */
export const DeviceLinkVerifySchema = DeviceSchema.extend({
  signature: z.string().min(1, 'signature is required'),
  nonce: z.string().min(1, 'nonce is required'),
});

export type ChallengeBody = z.infer<typeof ChallengeSchema>;
export type DeviceBody = z.infer<typeof DeviceSchema>;
export type VerifyBody = z.infer<typeof VerifySchema>;
export type DeviceLinkVerifyBody = z.infer<typeof DeviceLinkVerifySchema>;
