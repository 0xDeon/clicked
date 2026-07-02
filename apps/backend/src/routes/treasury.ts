import { Router, type Response, type IRouter } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { treasuryProposals, proposalVotes } from '../db/schema.js';
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
  conversationId: z.string().uuid().optional(),
  threshold: z.number().int().min(1).optional(),
});

const voteSchema = z.object({
  signature: z.string().optional(),
});

/**
 * POST /treasury/propose
 * Body: { amount, token, recipient, ttl, conversationId?, threshold? }
 */
treasuryRouter.post('/propose', validate(proposeSchema), async (req, res) => {
  const { amount, token, recipient, ttl, conversationId, threshold } =
    req.body as z.infer<typeof proposeSchema>;

  const [proposal] = await db
    .insert(treasuryProposals)
    .values({
      contractId: process.env.GROUP_TREASURY_CONTRACT_ID ?? 'stub',
      proposalId: `prop-${Date.now()}`,
      conversationId: conversationId ?? null,
      status: 'active',
      recipient,
      amount: String(amount),
      token,
      threshold: threshold ?? 3,
    })
    .returning();

  res.status(201).json({ ...proposal, ttlLedgers: TTL_LEDGERS[ttl] });
});

/**
 * GET /treasury/proposals?conversationId=
 * Returns proposals (optionally filtered by conversationId) with the
 * authenticated user's vote status included in each row.
 */
treasuryRouter.get('/proposals', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const cid = typeof req.query.conversationId === 'string' ? req.query.conversationId : null;

  const rows = await db
    .select()
    .from(treasuryProposals)
    .where(cid ? eq(treasuryProposals.conversationId, cid) : undefined)
    .orderBy(desc(treasuryProposals.createdAt));

  if (rows.length === 0) {
    res.json([]);
    return;
  }

  const ids = rows.map((r) => r.id);
  const votes = await db
    .select({ treasuryProposalId: proposalVotes.treasuryProposalId, vote: proposalVotes.vote })
    .from(proposalVotes)
    .where(and(eq(proposalVotes.userId, auth.userId), inArray(proposalVotes.treasuryProposalId, ids)));

  const votedMap = new Map(votes.map((v) => [v.treasuryProposalId, v.vote]));

  res.json(
    rows.map((r) => ({
      ...r,
      hasVoted: votedMap.has(r.id),
      myVote: votedMap.get(r.id) ?? null,
    })),
  );
});

async function handleVote(req: AuthRequest, res: Response, vote: 'approve' | 'reject'): Promise<void> {
  const auth = req.auth!;
  const { id } = req.params as { id: string };
  const { signature } = req.body as z.infer<typeof voteSchema>;

  const [proposal] = await db
    .select()
    .from(treasuryProposals)
    .where(eq(treasuryProposals.id, id))
    .limit(1);

  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }

  if (proposal.status !== 'active') {
    res.status(409).json({ error: 'Proposal is no longer active' });
    return;
  }

  try {
    await db.insert(proposalVotes).values({
      treasuryProposalId: proposal.id,
      userId: auth.userId,
      vote,
      signature: signature ?? null,
    });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '23505') {
      res.status(409).json({ error: 'Already voted on this proposal' });
      return;
    }
    throw err;
  }

  res.json({ success: true });
}

/**
 * POST /treasury/proposals/:id/approve
 * POST /treasury/proposals/:id/reject
 * Body: { signature?: string }
 */
treasuryRouter.post('/proposals/:id/approve', validate(voteSchema), async (req, res) => {
  await handleVote(req as AuthRequest, res, 'approve');
});

treasuryRouter.post('/proposals/:id/reject', validate(voteSchema), async (req, res) => {
  await handleVote(req as AuthRequest, res, 'reject');
});
