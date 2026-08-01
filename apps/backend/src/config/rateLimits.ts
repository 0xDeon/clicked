/**
 * Central rate-limit and quota configuration (#375).
 *
 * Every limit the gateway enforces is declared here — HTTP endpoints, socket
 * events and longer-window quotas alike — so an operator can see the whole
 * budget in one place instead of discovering an `incr` buried in a handler.
 *
 * Each bucket is overridable per environment with
 * `RATE_LIMIT_<BUCKET_NAME>=<limit>[/<windowSeconds>]`, e.g.
 *
 *   RATE_LIMIT_KEY_BUNDLE=60/60      # 60 fetches per minute
 *   RATE_LIMIT_AUTH_VERIFY=3         # 3 per minute (window unchanged)
 *
 * Limits are deliberately generous defaults: they exist to stop enumeration,
 * scraping and resource exhaustion, not to shape normal client behaviour.
 */

export interface RateLimitRule {
  /** Maximum cost permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Human-readable purpose, surfaced in logs and the docs table. */
  description: string;
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;

/**
 * Bucket defaults. Keys are used verbatim (upper-cased) to build the env
 * override name, so renaming a bucket renames its variable.
 */
export const RATE_LIMIT_DEFAULTS = {
  // ── HTTP: unauthenticated ──────────────────────────────────────────────────
  global_ip: {
    limit: 600,
    windowSeconds: MINUTE,
    description: 'Catch-all per-IP ceiling across every HTTP endpoint',
  },
  auth_challenge: {
    limit: 10,
    windowSeconds: MINUTE,
    description: 'Wallet challenge nonce issuance',
  },
  auth_verify: {
    limit: 5,
    windowSeconds: MINUTE,
    description: 'Signature verification attempts',
  },

  // ── HTTP: authenticated ────────────────────────────────────────────────────
  key_bundle: {
    limit: 30,
    windowSeconds: MINUTE,
    description: 'X3DH prekey bundle fetches',
  },
  key_bundle_daily: {
    limit: 200,
    windowSeconds: DAY,
    description: 'Daily prekey bundle quota — bounds one-time prekey drain',
  },
  upload_slot: {
    limit: 20,
    windowSeconds: MINUTE,
    description: 'Presigned upload slot requests',
  },
  upload_bytes_daily: {
    limit: 2 * 1024 * 1024 * 1024,
    windowSeconds: DAY,
    description: 'Daily upload volume quota per user, in bytes',
  },
  file_download: {
    limit: 120,
    windowSeconds: MINUTE,
    description: 'Presigned download URL issuance',
  },
  push_subscribe: {
    limit: 10,
    windowSeconds: MINUTE,
    description: 'Web-push subscription registration',
  },

  // ── Socket events ──────────────────────────────────────────────────────────
  socket_default: {
    limit: 10,
    windowSeconds: 1,
    description: 'Default ceiling for any socket event without its own bucket',
  },
  socket_send_message: {
    limit: 30,
    windowSeconds: 10,
    description: 'send_message and send_file_message',
  },
  socket_typing: {
    limit: 20,
    windowSeconds: 5,
    description: 'typing_start and typing_stop',
  },
  socket_ask_assistant: {
    limit: 5,
    windowSeconds: MINUTE,
    description: 'AI assistant invocations',
  },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_DEFAULTS;

/** Socket events that get their own bucket; everything else uses `socket_default`. */
const SOCKET_EVENT_BUCKETS: Record<string, RateLimitBucket> = {
  send_message: 'socket_send_message',
  send_file_message: 'socket_send_message',
  typing_start: 'socket_typing',
  typing_stop: 'socket_typing',
  ask_assistant: 'socket_ask_assistant',
};

export function socketEventBucket(event: string): RateLimitBucket {
  return SOCKET_EVENT_BUCKETS[event] ?? 'socket_default';
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolve a bucket against the environment. Read on every call rather than
 * cached at import time: the test suite and the operational runbook both rely
 * on being able to change a limit without restarting the module graph.
 */
export function getRateLimitRule(
  bucket: RateLimitBucket,
  source: NodeJS.ProcessEnv = process.env,
): RateLimitRule {
  const fallback = RATE_LIMIT_DEFAULTS[bucket];
  const override = source[`RATE_LIMIT_${bucket.toUpperCase()}`]?.trim();

  if (!override) {
    // Honour the historical socket knob so existing deployments keep working.
    if (bucket === 'socket_default') {
      const legacy = positiveInt(source['SOCKET_RATE_LIMIT_PER_SEC']);
      if (legacy !== undefined) {
        return { ...fallback, limit: legacy, windowSeconds: 1 };
      }
    }
    return fallback;
  }

  const [rawLimit, rawWindow] = override.split('/', 2);
  const limit = positiveInt(rawLimit);

  if (limit === undefined) {
    console.warn(`[rateLimit] ignoring malformed RATE_LIMIT_${bucket.toUpperCase()}="${override}"`);
    return fallback;
  }

  return {
    ...fallback,
    limit,
    windowSeconds: positiveInt(rawWindow) ?? fallback.windowSeconds,
  };
}

/** Kill switch for local debugging and load tests. Never set in production. */
export function isRateLimitingDisabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source['RATE_LIMIT_DISABLED'] === 'true';
}
