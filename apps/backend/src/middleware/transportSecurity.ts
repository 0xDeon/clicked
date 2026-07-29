/**
 * HTTP transport-security middleware (#374).
 *
 * Rejects plaintext requests outside development and stamps every response
 * with HSTS plus the companion headers that stop a downgrade from being
 * useful (content sniffing, framing, referrer leakage of tokens in URLs).
 */
import type { Request, Response, NextFunction } from 'express';
import { hstsHeaderValue, isOriginAllowed, isTlsEnforced } from '../lib/transportSecurity.js';

/**
 * Paths that stay reachable over plaintext. Load balancers and container
 * orchestrators health-check the pod directly, before TLS termination — a 403
 * there would take a healthy gateway out of rotation.
 */
const PLAINTEXT_ALLOWED_PATHS = new Set(['/health']);

/** True when the request reached us over TLS, honouring trusted proxy hops. */
export function isRequestSecure(req: Request): boolean {
  // `req.secure` already consults X-Forwarded-Proto when `trust proxy` is set,
  // so it covers both the direct-TLS and terminated-at-the-edge deployments.
  if (req.secure) return true;

  // Some proxies forward the scheme under a non-standard header instead.
  const forwardedSsl = req.get('x-forwarded-ssl');
  return forwardedSsl?.toLowerCase() === 'on';
}

/**
 * Refuse `http://` outside dev, and add the response headers that keep a
 * browser on `https://` afterwards.
 */
export function enforceTransportSecurity(req: Request, res: Response, next: NextFunction): void {
  const enforced = isTlsEnforced();

  if (enforced) {
    const hsts = hstsHeaderValue();
    if (hsts) {
      res.setHeader('Strict-Transport-Security', hsts);
    }
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (!enforced || isRequestSecure(req) || PLAINTEXT_ALLOWED_PATHS.has(req.path)) {
    next();
    return;
  }

  res.status(403).json({
    error: 'tls_required',
    message: 'This endpoint is only available over https. Reconnect using https:// or wss://.',
  });
}

/**
 * Reject browser origins that are not on the allowlist. `cors()` already
 * withholds the `Access-Control-Allow-Origin` header for them, but that only
 * stops a browser from *reading* the response — the request still executed.
 * This rejects it before it reaches a route.
 */
export function enforceOriginPolicy(req: Request, res: Response, next: NextFunction): void {
  if (isOriginAllowed(req.get('origin'))) {
    next();
    return;
  }

  res.status(403).json({
    error: 'origin_not_allowed',
    message: 'Origin is not permitted to call this API.',
  });
}
