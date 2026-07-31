/**
 * Transport-security policy (#374).
 *
 * One place decides whether the gateway is allowed to speak plaintext. Both
 * the HTTP stack (`middleware/transportSecurity.ts`) and the Socket.IO
 * handshake (`middleware/socketSecurity.ts`) read their answers from here, so
 * an operator can never end up with an API that enforces TLS while the
 * WebSocket upgrade quietly accepts `ws://`.
 *
 * Policy:
 *   - Outside development/test, `https://` and `wss://` are the only accepted
 *     transports; plaintext requests and handshakes are refused.
 *   - TLS is almost always terminated by a load balancer, so "is this request
 *     secure?" is answered from `X-Forwarded-Proto` when the hop is trusted,
 *     falling back to the socket's own encryption state.
 *   - HSTS and the companion hardening headers are emitted whenever
 *     enforcement is on, so a browser that has seen one response never tries
 *     plaintext again.
 */

/** Environments in which plaintext transport is tolerated. */
const DEV_ENVIRONMENTS = new Set(['development', 'test']);

/** Default HSTS max-age: one year, the value required for preload lists. */
export const DEFAULT_HSTS_MAX_AGE_SECONDS = 31_536_000;

function envValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = source[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

/** Resolved deployment environment; anything unrecognised is treated as production. */
export function appEnvironment(source: NodeJS.ProcessEnv = process.env): string {
  return envValue(source, 'APP_ENV') ?? envValue(source, 'NODE_ENV') ?? 'development';
}

/** True when plaintext transport is acceptable (local dev and the test suite). */
export function isDevEnvironment(source: NodeJS.ProcessEnv = process.env): boolean {
  return DEV_ENVIRONMENTS.has(appEnvironment(source));
}

/**
 * Whether TLS must be enforced. `ENFORCE_TLS` is an explicit override in both
 * directions — set it to `true` to test the production posture locally, or to
 * `false` for a deliberately plaintext deployment behind a trusted mesh.
 */
export function isTlsEnforced(source: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(envValue(source, 'ENFORCE_TLS')) ?? !isDevEnvironment(source);
}

/** HSTS max-age in seconds. `HSTS_MAX_AGE` overrides; 0 disables the header. */
export function hstsMaxAge(source: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(source, 'HSTS_MAX_AGE');
  if (raw === undefined) return DEFAULT_HSTS_MAX_AGE_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HSTS_MAX_AGE_SECONDS;
  return parsed;
}

/** Value of the `Strict-Transport-Security` header, or null when disabled. */
export function hstsHeaderValue(source: NodeJS.ProcessEnv = process.env): string | null {
  const maxAge = hstsMaxAge(source);
  if (maxAge === 0) return null;
  const directives = [`max-age=${maxAge}`, 'includeSubDomains'];
  if (parseBoolean(envValue(source, 'HSTS_PRELOAD')) ?? true) {
    directives.push('preload');
  }
  return directives.join('; ');
}

/**
 * Number of reverse-proxy hops to trust for `X-Forwarded-*`. Defaults to 1
 * (the usual single load balancer). Set `TRUST_PROXY=0` when the gateway is
 * exposed directly, so a client cannot forge `X-Forwarded-Proto: https`.
 */
export function trustProxyHops(source: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(source, 'TRUST_PROXY');
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

/**
 * Origins permitted to call the API and open a socket. `ALLOWED_ORIGINS` is a
 * comma-separated list; an empty list means "no cross-origin restriction",
 * which is only allowed in dev — see `assertOriginPolicy`.
 */
export function allowedOrigins(source: NodeJS.ProcessEnv = process.env): string[] {
  const raw = envValue(source, 'ALLOWED_ORIGINS');
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

/**
 * True when `origin` may talk to this gateway. An absent Origin header (native
 * mobile clients, server-to-server callers, curl) is accepted — Origin is a
 * browser defence, and mobile clients are protected by certificate pinning
 * instead (see docs/security/tls-and-pinning.md).
 */
export function isOriginAllowed(
  origin: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return true;

  const allowlist = allowedOrigins(source);
  const normalized = origin.trim().replace(/\/+$/, '');

  if (allowlist.length > 0) {
    return allowlist.includes(normalized);
  }

  // No allowlist configured: permitted in dev, and outside dev the origin must
  // at least be an https one so a plaintext page cannot drive the socket.
  if (isDevEnvironment(source)) return true;
  return normalized.toLowerCase().startsWith('https://');
}

/**
 * Cookie attributes every cookie this service sets must carry. Kept here so
 * the handshake check and any future cookie writer agree on one definition.
 */
export function secureCookieOptions(source: NodeJS.ProcessEnv = process.env): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: '/';
} {
  return {
    httpOnly: true,
    secure: isTlsEnforced(source),
    sameSite: 'strict',
    path: '/',
  };
}

/**
 * Boot-time sanity check on the transport configuration.
 *
 * Enforcement defaults to on outside development, so plaintext is never
 * reached by omission — it takes an explicit `ENFORCE_TLS=false`, which is
 * loud but permitted (a service mesh may terminate TLS at the sidecar).
 *
 * What is *not* permitted is an allowlist that readmits plaintext through the
 * side door: an `http://` origin on a TLS-enforcing gateway means a plaintext
 * page is expected to drive the API, which defeats the whole policy. That is a
 * contradiction the operator must resolve, so it fails the boot.
 */
export function assertTransportSecurityConfig(source: NodeJS.ProcessEnv = process.env): void {
  const enforced = isTlsEnforced(source);

  if (!enforced && !isDevEnvironment(source)) {
    console.warn(
      `[security] ENFORCE_TLS=false in "${appEnvironment(source)}" — plaintext transport is accepted.`,
    );
  }

  if (!enforced) return;

  const origins = allowedOrigins(source);

  if (origins.length === 0) {
    console.warn(
      '[security] ALLOWED_ORIGINS is unset — browser origins are only checked for an https scheme.',
    );
    return;
  }

  const plaintextOrigins = origins.filter((origin) => origin.toLowerCase().startsWith('http://'));
  if (plaintextOrigins.length > 0) {
    throw new Error(
      `TLS is enforced but ALLOWED_ORIGINS contains plaintext origins: ${plaintextOrigins.join(', ')}. ` +
        'Serve those origins over https, or set ENFORCE_TLS=false to accept a plaintext deployment.',
    );
  }
}
