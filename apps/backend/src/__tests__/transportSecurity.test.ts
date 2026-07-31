/**
 * #374 — TLS/WSS enforcement, HSTS, origin/cookie handshake checks and the
 * published certificate-pinning policy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  allowedOrigins,
  hstsHeaderValue,
  isDevEnvironment,
  isOriginAllowed,
  isTlsEnforced,
  secureCookieOptions,
  assertTransportSecurityConfig,
  trustProxyHops,
  DEFAULT_HSTS_MAX_AGE_SECONDS,
} from '../lib/transportSecurity.js';
import { enforceOriginPolicy, enforceTransportSecurity } from '../middleware/transportSecurity.js';
import { socketTransportSecurityMiddleware } from '../middleware/socketSecurity.js';
import { getPinningPolicy, parsePins } from '../lib/certificatePinning.js';
import { securityRouter } from '../routes/security.js';

const TOUCHED_VARS = [
  'APP_ENV',
  'NODE_ENV',
  'ENFORCE_TLS',
  'HSTS_MAX_AGE',
  'HSTS_PRELOAD',
  'TRUST_PROXY',
  'ALLOWED_ORIGINS',
  'TLS_PINNED_HOSTS',
  'TLS_PINNED_SPKI_SHA256',
  'TLS_BACKUP_SPKI_SHA256',
  'TLS_PIN_MAX_AGE_SECONDS',
  'TLS_PIN_REPORT_URI',
] as const;

const originalEnv = new Map(TOUCHED_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/** Mount the middleware under test on a throwaway app with a trusted proxy. */
function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', trustProxyHops());
  app.use(enforceTransportSecurity);
  app.use(enforceOriginPolicy);
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/conversations', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const b64Pin = (char: string) => `sha256/${char.repeat(43)}=`;

function fakeSocket(overrides: {
  secure?: boolean;
  headers?: Record<string, string | string[]>;
}): Parameters<typeof socketTransportSecurityMiddleware>[0] {
  return {
    handshake: {
      secure: overrides.secure ?? false,
      headers: overrides.headers ?? {},
    },
  } as unknown as Parameters<typeof socketTransportSecurityMiddleware>[0];
}

function runSocketMiddleware(
  socket: Parameters<typeof socketTransportSecurityMiddleware>[0],
): Error | undefined {
  let captured: Error | undefined;
  socketTransportSecurityMiddleware(socket, (err) => {
    captured = err;
  });
  return captured;
}

// ─── policy resolution ────────────────────────────────────────────────────────

describe('transport-security policy', () => {
  it('treats development and test as plaintext-tolerant and everything else as not', () => {
    process.env['APP_ENV'] = 'development';
    expect(isDevEnvironment()).toBe(true);
    expect(isTlsEnforced()).toBe(false);

    process.env['APP_ENV'] = 'test';
    expect(isDevEnvironment()).toBe(true);

    process.env['APP_ENV'] = 'production';
    expect(isDevEnvironment()).toBe(false);
    expect(isTlsEnforced()).toBe(true);

    // An unrecognised environment must fail safe, not fall back to dev.
    process.env['APP_ENV'] = 'staging';
    expect(isTlsEnforced()).toBe(true);
  });

  it('honours ENFORCE_TLS as an override in both directions', () => {
    process.env['APP_ENV'] = 'development';
    process.env['ENFORCE_TLS'] = 'true';
    expect(isTlsEnforced()).toBe(true);

    process.env['APP_ENV'] = 'production';
    process.env['ENFORCE_TLS'] = 'false';
    expect(isTlsEnforced()).toBe(false);
  });

  it('refuses to boot when the allowlist readmits plaintext through the side door', () => {
    process.env['APP_ENV'] = 'production';
    delete process.env['ENFORCE_TLS'];
    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz,http://legacy.clicked.xyz';

    expect(() => assertTransportSecurityConfig()).toThrow(/plaintext origins/);

    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz';
    expect(() => assertTransportSecurityConfig()).not.toThrow();

    // A deliberate plaintext deployment is loud but permitted.
    process.env['ENFORCE_TLS'] = 'false';
    process.env['ALLOWED_ORIGINS'] = 'http://legacy.clicked.xyz';
    expect(() => assertTransportSecurityConfig()).not.toThrow();
  });

  it('builds an HSTS header with a one-year max-age by default', () => {
    delete process.env['HSTS_MAX_AGE'];
    delete process.env['HSTS_PRELOAD'];
    expect(hstsHeaderValue()).toBe(
      `max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`,
    );

    process.env['HSTS_PRELOAD'] = 'false';
    expect(hstsHeaderValue()).toBe(`max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains`);

    process.env['HSTS_MAX_AGE'] = '0';
    expect(hstsHeaderValue()).toBeNull();
  });

  it('parses the origin allowlist, ignoring blanks and trailing slashes', () => {
    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz/, ,https://admin.clicked.xyz';
    expect(allowedOrigins()).toEqual(['https://app.clicked.xyz', 'https://admin.clicked.xyz']);
  });

  it('allows only allowlisted origins, and requires https when no list is set', () => {
    process.env['APP_ENV'] = 'production';
    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz';
    expect(isOriginAllowed('https://app.clicked.xyz')).toBe(true);
    expect(isOriginAllowed('https://app.clicked.xyz/')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    // Absent Origin (native mobile, server-to-server) is not a browser request.
    expect(isOriginAllowed(undefined)).toBe(true);

    delete process.env['ALLOWED_ORIGINS'];
    expect(isOriginAllowed('https://anything.example')).toBe(true);
    expect(isOriginAllowed('http://anything.example')).toBe(false);
  });

  it('marks cookies Secure whenever TLS is enforced', () => {
    process.env['APP_ENV'] = 'production';
    expect(secureCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });

    process.env['APP_ENV'] = 'development';
    expect(secureCookieOptions().secure).toBe(false);
  });

  it('defaults to trusting one proxy hop and accepts an explicit zero', () => {
    delete process.env['TRUST_PROXY'];
    expect(trustProxyHops()).toBe(1);

    process.env['TRUST_PROXY'] = '0';
    expect(trustProxyHops()).toBe(0);

    process.env['TRUST_PROXY'] = 'nonsense';
    expect(trustProxyHops()).toBe(1);
  });
});

// ─── HTTP enforcement ─────────────────────────────────────────────────────────

describe('HTTP transport enforcement', () => {
  it('AC1 — rejects plaintext requests outside dev', async () => {
    process.env['APP_ENV'] = 'production';
    delete process.env['ALLOWED_ORIGINS'];

    const res = await request(buildApp()).get('/conversations');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tls_required');
  });

  it('accepts the same request when the edge proxy reports https', async () => {
    process.env['APP_ENV'] = 'production';

    const res = await request(buildApp()).get('/conversations').set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
  });

  it('accepts plaintext in development', async () => {
    process.env['APP_ENV'] = 'development';

    const res = await request(buildApp()).get('/conversations');

    expect(res.status).toBe(200);
  });

  it('keeps /health reachable over plaintext so probes do not fail the pod', async () => {
    process.env['APP_ENV'] = 'production';

    const res = await request(buildApp()).get('/health');

    expect(res.status).toBe(200);
  });

  it('AC2 — sets HSTS and the companion hardening headers', async () => {
    process.env['APP_ENV'] = 'production';

    const res = await request(buildApp()).get('/conversations').set('X-Forwarded-Proto', 'https');

    expect(res.headers['strict-transport-security']).toBe(
      `max-age=${DEFAULT_HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not send HSTS from a dev server', async () => {
    process.env['APP_ENV'] = 'development';

    const res = await request(buildApp()).get('/conversations');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('rejects a request from an origin outside the allowlist', async () => {
    process.env['APP_ENV'] = 'production';
    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz';

    const app = buildApp();

    const blocked = await request(app)
      .get('/conversations')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://evil.example');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('origin_not_allowed');

    const allowed = await request(app)
      .get('/conversations')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://app.clicked.xyz');
    expect(allowed.status).toBe(200);
  });
});

// ─── WebSocket handshake ──────────────────────────────────────────────────────

describe('WebSocket handshake enforcement', () => {
  it('AC1 — rejects a ws:// handshake outside dev', () => {
    process.env['APP_ENV'] = 'production';
    delete process.env['ALLOWED_ORIGINS'];

    const err = runSocketMiddleware(fakeSocket({ secure: false }));

    expect(err?.message).toMatch(/wss/i);
  });

  it('accepts a wss:// handshake and a proxied https handshake', () => {
    process.env['APP_ENV'] = 'production';

    expect(runSocketMiddleware(fakeSocket({ secure: true }))).toBeUndefined();
    expect(
      runSocketMiddleware(fakeSocket({ headers: { 'x-forwarded-proto': 'https,http' } })),
    ).toBeUndefined();
  });

  it('accepts a ws:// handshake in development', () => {
    process.env['APP_ENV'] = 'development';

    expect(runSocketMiddleware(fakeSocket({ secure: false }))).toBeUndefined();
  });

  it('rejects a handshake from a non-allowlisted origin', () => {
    process.env['APP_ENV'] = 'production';
    process.env['ALLOWED_ORIGINS'] = 'https://app.clicked.xyz';

    const blocked = runSocketMiddleware(
      fakeSocket({ secure: true, headers: { origin: 'https://evil.example' } }),
    );
    expect(blocked?.message).toMatch(/origin/i);

    const allowed = runSocketMiddleware(
      fakeSocket({ secure: true, headers: { origin: 'https://app.clicked.xyz' } }),
    );
    expect(allowed).toBeUndefined();
  });

  it('never lets a cookie ride an insecure handshake, even in dev', () => {
    process.env['APP_ENV'] = 'development';

    const err = runSocketMiddleware(
      fakeSocket({ secure: false, headers: { cookie: 'session=abc' } }),
    );
    expect(err?.message).toMatch(/cookie/i);

    expect(
      runSocketMiddleware(fakeSocket({ secure: true, headers: { cookie: 'session=abc' } })),
    ).toBeUndefined();
  });
});

// ─── certificate pinning ──────────────────────────────────────────────────────

describe('certificate-pinning policy', () => {
  it('drops malformed pins instead of serving them', () => {
    const { pins, invalid } = parsePins(`${b64Pin('A')},not-a-pin,sha256/short`);

    expect(pins).toEqual([b64Pin('A')]);
    expect(invalid).toEqual(['not-a-pin', 'sha256/short']);
  });

  it('AC3 — only tells clients to hard-fail once a backup pin exists', () => {
    process.env['TLS_PINNED_SPKI_SHA256'] = b64Pin('A');
    delete process.env['TLS_BACKUP_SPKI_SHA256'];
    expect(getPinningPolicy().enforced).toBe(false);

    process.env['TLS_BACKUP_SPKI_SHA256'] = b64Pin('B');
    const policy = getPinningPolicy();
    expect(policy.enforced).toBe(true);
    expect(policy.pins).toEqual([b64Pin('A')]);
    expect(policy.backupPins).toEqual([b64Pin('B')]);
  });

  it('AC3 — publishes the policy for mobile clients without authentication', async () => {
    process.env['APP_ENV'] = 'production';
    process.env['TLS_PINNED_HOSTS'] = 'api.clicked.xyz';
    process.env['TLS_PINNED_SPKI_SHA256'] = b64Pin('A');
    process.env['TLS_BACKUP_SPKI_SHA256'] = b64Pin('B');
    process.env['TLS_PIN_MAX_AGE_SECONDS'] = '600';

    const app = express();
    app.use('/security', securityRouter);

    const res = await request(app).get('/security/transport-policy');

    expect(res.status).toBe(200);
    expect(res.body.tls.required).toBe(true);
    expect(res.body.tls.minimumVersion).toBe('TLSv1.2');
    expect(res.body.pinning).toMatchObject({
      enforced: true,
      hosts: ['api.clicked.xyz'],
      pins: [b64Pin('A')],
      backupPins: [b64Pin('B')],
      maxAgeSeconds: 600,
    });
    expect(res.headers['cache-control']).toBe('public, max-age=600');
  });
});
