import { Router, type IRouter } from 'express';

import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const treasuryRouter: IRouter = Router();

treasuryRouter.use(requireAuth);

const TTL_LEDGERS: Record<string, number> = {
  '24h': 17280, // ~24 h at 5 s/ledger
  '72h': 51840,
  '7d': 120960,
};

const proposeSchema = z.object({
  amount: z.number().positive(),
  token: z.string().min(1),
  recipient: z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key'),
  ttl: z.enum(['24h', '72h', '7d']),
});

/**
 * POST /treasury/propose
 * Body: { amount, token, recipient, ttl }
 * Stub: records intent and returns the ledger count for TTL.
 */
treasuryRouter.post('/propose', validate(proposeSchema), async (req, res) => {
  const { amount, token, recipient, ttl } = req.body as z.infer<typeof proposeSchema>;
  const auth = (req as AuthRequest).auth!;

  // In production this would submit a multisig proposal transaction via Soroban SDK.
  // For now, return the resolved ledger TTL so the frontend can display it.
  res.status(201).json({
    proposer: auth.userId,
    amount,
    token,
    recipient,
    ttlLedgers: TTL_LEDGERS[ttl],
  });
});
