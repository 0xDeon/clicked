/**
 * Express rate-limit middleware built on the shared Redis counters (#375).
 *
 * A limiter is identified by the authenticated user when there is one and by
 * the client IP otherwise. Keying on the user matters: an account with a
 * hundred devices behind one NAT must not be able to exhaust a shared IP
 * budget, and an attacker must not be able to dodge a per-account quota by
 * rotating source addresses.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthRequest } from './auth.js';
import { consumeRateLimit, type RateLimitResult } from '../services/rateLimiter.js';
import type { RateLimitBucket } from '../config/rateLimits.js';

/** Derive the subject a limit is charged to. */
export function defaultIdentifier(req: Request): string {
  const auth = (req as AuthRequest).auth;
  if (auth?.userId) return `user:${auth.userId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

/** Always charge the IP, for routes that run before authentication. */
export function ipIdentifier(req: Request): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

function applyHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('RateLimit-Limit', String(result.limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(result.resetSeconds));
}

export interface RateLimitOptions {
  /** How to identify the subject. Defaults to user-then-IP. */
  identifier?: (req: Request) => string;
  /** Charge more than one unit — used for volume quotas. Defaults to 1. */
  cost?: (req: Request) => number;
}

/**
 * Enforce one or more buckets on a route. Multiple buckets let a short burst
 * limit and a long-window quota guard the same endpoint: the burst window
 * stops a scraper, the daily window stops a slow drip that never trips it.
 */
export function rateLimit(
  buckets: RateLimitBucket | RateLimitBucket[],
  options: RateLimitOptions = {},
): RequestHandler {
  const bucketList = Array.isArray(buckets) ? buckets : [buckets];
  const identify = options.identifier ?? defaultIdentifier;
  const costOf = options.cost ?? (() => 1);

  return async function rateLimitHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const identifier = identify(req);
    const cost = Math.max(0, costOf(req));

    for (const bucket of bucketList) {
      const result = await consumeRateLimit(bucket, identifier, cost);

      if (!result.allowed) {
        applyHeaders(res, result);
        res.setHeader('Retry-After', String(result.resetSeconds));
        res.status(429).json({
          error: 'Too many requests',
          bucket,
          retryAfterSeconds: result.resetSeconds,
        });
        return;
      }

      // Report the tightest remaining budget across the buckets checked.
      const reported = Number(res.getHeader('RateLimit-Remaining'));
      if (Number.isNaN(reported) || result.remaining < reported) {
        applyHeaders(res, result);
      }
    }

    next();
  };
}
