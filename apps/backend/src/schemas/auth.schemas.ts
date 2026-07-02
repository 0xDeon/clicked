import { z } from 'zod';
import { IdentityPublicKeySchema } from '../lib/keys.js';

export const ChallengeSchema = z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
});

const DeviceRegistrationSchema = z.object({
  deviceId: z.string().min(1, 'deviceId is required').optional(),
  deviceName: z.string().min(1, 'deviceName is required').optional(),
  platform: z.enum(['web', 'ios', 'android']).optional(),
  registrationId: z.string().optional(),
});

export const DeviceSchema = z.object({
  deviceId: z.string().min(1, 'deviceId is required'),
  deviceName: z.string().min(1, 'deviceName is required'),
  platform: z.string().min(1, 'platform is required'),
  identityPublicKey: IdentityPublicKeySchema,
  registrationId: z.string().optional(),
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
  })
  .merge(DeviceRegistrationSchema);
export const VerifySchema = z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
  signature: z.string().min(1, 'signature is required'),
  nonce: z.string().min(1, 'nonce is required'),
  /**
   * Base64-encoded Ed25519 SPKI DER identity public key (44 bytes).
   * Validated for correct base64 and exact byte length before any crypto operation.
   */
  identityPublicKey: IdentityPublicKeySchema,
  deviceName: z.string().min(1).max(100).optional(),
  platform: z.enum(['web', 'ios', 'android']).optional(),
  registrationId: z.number().int().nonnegative().optional(),
});


export type ChallengeBody = z.infer<typeof ChallengeSchema>;
export type DeviceBody = z.infer<typeof DeviceSchema>;
export type VerifyBody = z.infer<typeof VerifySchema>;
