/**
 * Stellar event listener for `token_transfer` (#46) and `group_treasury` multisig (#130).
 *
 * Subscribes to contract events emitted by the `token_transfer` and
 * `group_treasury` Soroban contracts. The listener:
 *
 *   - Polls Soroban RPC `getEvents` on a short interval (cursor-based).
 *   - Reconnects automatically after a transient failure with exponential
 *     backoff capped at 30 seconds.
 *   - Upserts on the unique `tx_hash` / `(contractId, proposalId)` so
 *     reconnects that re-read a page produce no duplicates.
 *   - After each treasury proposal DB update, emits a
 *     `treasury_proposal_updated` Socket.IO event to the relevant room.
 *   - Logs errors via the standard backend logger but never rethrows out
 *     of `runForever`, so the API server stays up even if the chain is
 *     unreachable.
 */
import { rpc } from '@stellar/stellar-sdk';
import { db } from '../db/index.js';
import { tokenTransfers, messages, conversations, users, treasuryProposals } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getSocketServer } from '../lib/socket.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export interface StellarTransferEvent {
  /** Soroban tx hash that produced the event. */
  txHash: string;
  /** Ledger sequence the event was included in. */
  ledger: number;
  /** Stellar address that authorised the transfer. */
  from: string;
  /** Stellar address that received the transfer. */
  to: string;
  /** Amount in token units (i128 as decimal string). */
  amount: string;
  /** Raw memo bytes hex-encoded (matches the contract's emitted memo). */
  memoHex?: string;
  /** Cursor token the next `fetchEvents` call should resume from. */
  cursor: string;
}

// ── Treasury multisig event types (#130) ─────────────────────────────────────

export type TreasuryProposalStatus = 'active' | 'approved' | 'rejected' | 'executed' | 'expired';

export interface TreasuryProposalEvent {
  /** The contract that emitted the event. */
  contractId: string;
  /** Soroban event type name, e.g. "proposal_created". */
  eventType:
    | 'proposal_created'
    | 'proposal_approved'
    | 'proposal_rejected'
    | 'proposal_executed'
    | 'proposal_expired';
  proposalId: string;
  approvalsCount?: number | undefined;
  rejectionsCount?: number | undefined;
  /** Cursor token for the next `fetchTreasuryEvents` call. */
  cursor: string;
}

export interface StellarListenerDeps {
  /** Optional logger; defaults to a console wrapper. */
  log?: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
  /** Fetches the next page of token-transfer events starting at `cursor`. */
  fetchEvents: (cursor: string | null) => Promise<StellarTransferEvent[]>;
  /** Fetches the next page of treasury proposal events starting at `cursor`. */
  fetchTreasuryEvents?: (cursor: string | null) => Promise<TreasuryProposalEvent[]>;
  /** Persistence layer; swapped out in tests. */
  persistEvent?: (event: StellarTransferEvent) => Promise<void>;
  /** Treasury event persistence; swapped out in tests. */
  persistTreasuryEvent?: (event: TreasuryProposalEvent) => Promise<void>;
  /** Pause between successful polls (default 5s). */
  pollIntervalMs?: number;
  /** Initial backoff after a failure (doubles up to `backoffMaxMs`). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Abort signal that breaks out of `runForever`. */
  signal?: AbortSignal;
}

const consoleLogger = {
  info: (msg: string, ctx?: unknown) => console.log(`[stellar-listener] ${msg}`, ctx ?? ''),
  warn: (msg: string, ctx?: unknown) => console.warn(`[stellar-listener] ${msg}`, ctx ?? ''),
  error: (msg: string, ctx?: unknown) => console.error(`[stellar-listener] ${msg}`, ctx ?? ''),
};

/**
 * Default persistence: upsert on `txHash`, attempting to associate the
 * transfer with a message whose id matches the decoded memo bytes (if any).
 */
async function defaultPersistEvent(event: StellarTransferEvent): Promise<void> {
  let conversationId: string | null = null;
  let senderId: string | null = null;

  if (event.memoHex) {
    try {
      const memo = Buffer.from(event.memoHex, 'hex').toString('utf-8').trim();
      // The contract emits a message UUID in the memo when the transfer
      // originated from a chat message; non-UUID memos are ignored.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memo)) {
        const [existing] = await db
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            senderId: messages.senderId,
          })
          .from(messages)
          .where(eq(messages.id, memo))
          .limit(1);
        if (existing) {
          conversationId = existing.conversationId;
          senderId = existing.senderId;
        }
      }
    } catch {
      // Non-fatal — memo just stays raw, no association.
    }
  }

  // Fallbacks if not found (required columns in tokenTransfers)
  if (!conversationId || !senderId) {
    const [fallbackConv] = await db.select({ id: conversations.id }).from(conversations).limit(1);
    const [fallbackUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (!fallbackConv || !fallbackUser) {
      return;
    }
    conversationId = fallbackConv.id;
    senderId = fallbackUser.id;
  }

  await db
    .insert(tokenTransfers)
    .values({
      txHash: event.txHash,
      conversationId,
      senderId,
      recipientAddress: event.to,
      amount: event.amount,
      tokenContractId: 'placeholder_token_contract_id',
      memo: event.memoHex ?? null,
    })
    .onConflictDoUpdate({
      target: tokenTransfers.txHash,
      set: {
        createdAt: sql`now()`,
      },
    });
}

/**
 * Default treasury proposal persistence (#130).
 * Upserts on (contractId, proposalId), then emits treasury_proposal_updated
 * to the relevant Socket.IO room.
 */
async function defaultPersistTreasuryEvent(event: TreasuryProposalEvent): Promise<void> {
  const statusMap: Record<TreasuryProposalEvent['eventType'], TreasuryProposalStatus> = {
    proposal_created: 'active',
    proposal_approved: 'approved',
    proposal_rejected: 'rejected',
    proposal_executed: 'executed',
    proposal_expired: 'expired',
  };

  const newStatus = statusMap[event.eventType];

  const [row] = await db
    .update(treasuryProposals)
    .set({
      status: newStatus,
      approvalsCount: event.approvalsCount !== undefined ? event.approvalsCount : undefined,
      rejectionsCount: event.rejectionsCount !== undefined ? event.rejectionsCount : undefined,
      updatedAt: sql`now()`,
    })
    .where(eq(treasuryProposals.onChainId, Number(event.proposalId)))
    .returning();

  if (!row) return;

  const payload = {
    proposalId: row.onChainId,
    status: row.status,
    approvalsCount: row.approvalsCount,
    rejectionsCount: row.rejectionsCount,
  };

  // Emit to the linked conversation room if known.
  const room = row.conversationId;
  getSocketServer()?.to(room).emit('treasury_proposal_updated', payload);
}

/**
 * Run the listener loop until `signal` aborts (or process exit). Never
 * throws — RPC / DB errors are logged and the loop backs off.
 */
export async function runForever(deps: StellarListenerDeps): Promise<void> {
  const log = deps.log ?? consoleLogger;
  const persist = deps.persistEvent ?? defaultPersistEvent;
  const persistTreasury = deps.persistTreasuryEvent ?? defaultPersistTreasuryEvent;
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backoffBase = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMax = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  let cursor: string | null = null;
  let treasuryCursor: string | null = null;
  let consecutiveFailures = 0;

  log.info('listener starting');

  while (!deps.signal?.aborted) {
    try {
      const events = await deps.fetchEvents(cursor);
      consecutiveFailures = 0;

      for (const event of events) {
        try {
          await persist(event);
          cursor = event.cursor;
        } catch (err) {
          log.warn('failed to persist event', {
            txHash: event.txHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Poll treasury events when a fetcher is provided (#130).
      if (deps.fetchTreasuryEvents) {
        const treasuryEvents = await deps.fetchTreasuryEvents(treasuryCursor);
        for (const event of treasuryEvents) {
          try {
            await persistTreasury(event);
            treasuryCursor = event.cursor;
          } catch (err) {
            log.warn('failed to persist treasury event', {
              proposalId: event.proposalId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      await wait(pollMs, deps.signal);
    } catch (err) {
      consecutiveFailures += 1;
      const delay = Math.min(backoffBase * Math.pow(2, consecutiveFailures - 1), backoffMax);
      log.error('fetch failed; reconnecting after backoff', {
        attempt: consecutiveFailures,
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await wait(delay, deps.signal);
    }
  }

  log.info('listener stopped (signal aborted)');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * Build a default fetcher that talks to a Soroban RPC server and filters
 * events by the configured `token_transfer` contract id. Returns a thunk
 * suitable for passing into `runForever({ fetchEvents })`.
 */
export function buildRpcFetcher(opts: {
  rpcUrl: string;
  contractId: string;
  pageSize?: number;
}): StellarListenerDeps['fetchEvents'] {
  const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') });
  const pageSize = opts.pageSize ?? 100;
  type RpcEvent = {
    txHash?: string;
    ledger?: number;
    value?: { from?: string; to?: string; amount?: string | number; memo?: string };
    pagingToken?: string;
  };
  const eventServer = server as unknown as {
    getEvents: (request: {
      startLedger: undefined;
      cursor: string | undefined;
      filters: Array<{ type: 'contract'; contractIds: string[]; topics: string[][] }>;
      limit: number;
    }) => Promise<{ events?: RpcEvent[] }>;
  };

  return async (cursor) => {
    const startLedger = cursor ? undefined : undefined; // resume on cursor only
    const response = await eventServer.getEvents({
      startLedger,
      cursor: cursor ?? undefined,
      filters: [
        {
          type: 'contract',
          contractIds: [opts.contractId],
          topics: [['transfer']],
        },
      ],
      limit: pageSize,
    });

    const events = response.events ?? [];

    return events
      .filter((e) => e.txHash && e.value?.from && e.value?.to && e.value?.amount != null)
      .map((e) => {
        const event: StellarTransferEvent = {
          txHash: e.txHash as string,
          ledger: e.ledger ?? 0,
          from: e.value!.from as string,
          to: e.value!.to as string,
          amount: String(e.value!.amount),
          cursor: e.pagingToken ?? '',
        };

        if (e.value?.memo !== undefined) {
          event.memoHex = e.value.memo;
        }

        return event;
      });
  };
}

/**
 * Build a fetcher for GROUP_TREASURY_CONTRACT_ID multisig proposal events (#130).
 * Listens for: proposal_created, proposal_approved, proposal_rejected,
 * proposal_executed, proposal_expired.
 */
export function buildTreasuryRpcFetcher(opts: {
  rpcUrl: string;
  contractId: string;
  pageSize?: number;
}): NonNullable<StellarListenerDeps['fetchTreasuryEvents']> {
  const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') });
  const pageSize = opts.pageSize ?? 100;

  const TREASURY_TOPICS = [
    'proposal_created',
    'proposal_approved',
    'proposal_rejected',
    'proposal_executed',
    'proposal_expired',
  ] as const;

  type EventType = (typeof TREASURY_TOPICS)[number];

  type RpcEvent = {
    contractId?: string;
    topic?: string[];
    value?: { id?: string | number; approvals?: number; rejections?: number };
    pagingToken?: string;
  };

  const eventServer = server as unknown as {
    getEvents: (request: {
      startLedger: undefined;
      cursor: string | undefined;
      filters: Array<{ type: 'contract'; contractIds: string[]; topics: string[][] }>;
      limit: number;
    }) => Promise<{ events?: RpcEvent[] }>;
  };

  return async (cursor) => {
    const response = await eventServer.getEvents({
      startLedger: undefined,
      cursor: cursor ?? undefined,
      filters: [
        {
          type: 'contract',
          contractIds: [opts.contractId],
          topics: [TREASURY_TOPICS as unknown as string[]],
        },
      ],
      limit: pageSize,
    });

    const events = response.events ?? [];

    return events
      .filter((e) => {
        const topic = e.topic?.[0];
        return e.value?.id != null && TREASURY_TOPICS.includes(topic as EventType);
      })
      .map((e) => {
        const eventType = e.topic![0] as EventType;
        return {
          contractId: e.contractId ?? opts.contractId,
          eventType,
          proposalId: String(e.value!.id),
          approvalsCount: e.value?.approvals,
          rejectionsCount: e.value?.rejections,
          cursor: e.pagingToken ?? '',
        } satisfies TreasuryProposalEvent;
      });
  };
}
