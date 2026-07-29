/**
 * Certificate-pinning policy surface (#374).
 *
 * The gateway cannot pin anything itself — pinning is enforced by the client.
 * What it can do is publish, in one machine-readable place, the SPKI hashes a
 * mobile client is expected to trust, so pin rotation is a config change on the
 * server instead of an app release. `GET /security/transport-policy` serves
 * this document; `docs/security/tls-and-pinning.md` explains how the iOS and
 * Android clients are expected to consume it.
 *
 * Pins are SHA-256 hashes of the certificate's Subject Public Key Info, base64
 * encoded, in the `sha256/<base64>` form used by HPKP, TrustKit and OkHttp.
 * They are public values: serving them unauthenticated is deliberate, because a
 * client must be able to bootstrap its pin set before it holds a token.
 */

/** `sha256/` + base64 of a 32-byte digest (44 chars incl. padding). */
const PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/;

/** Default pin lifetime advertised to clients: 60 days. */
export const DEFAULT_PIN_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

export interface PinningPolicy {
  /** Whether clients should hard-fail a connection that violates the pin set. */
  enforced: boolean;
  /** Hostnames the pin set applies to. */
  hosts: string[];
  /** Currently-served leaf/intermediate SPKI pins. */
  pins: string[];
  /** Backup pins for not-yet-deployed keys. Required for safe rotation. */
  backupPins: string[];
  /** How long a client may cache this policy before re-fetching, in seconds. */
  maxAgeSeconds: number;
  /** Optional endpoint clients POST pin-validation failures to. */
  reportUri: string | null;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Split a configured pin list into valid pins and rejected entries. Malformed
 * pins are dropped rather than served: shipping a typo'd pin to a client that
 * hard-fails on mismatch would lock the whole fleet out.
 */
export function parsePins(raw: string | undefined): { pins: string[]; invalid: string[] } {
  const pins: string[] = [];
  const invalid: string[] = [];

  for (const candidate of parseList(raw)) {
    if (PIN_PATTERN.test(candidate)) {
      pins.push(candidate);
    } else {
      invalid.push(candidate);
    }
  }

  return { pins, invalid };
}

/** Build the pinning policy from the environment. */
export function getPinningPolicy(source: NodeJS.ProcessEnv = process.env): PinningPolicy {
  const { pins, invalid } = parsePins(source['TLS_PINNED_SPKI_SHA256']);
  const { pins: backupPins, invalid: invalidBackup } = parsePins(source['TLS_BACKUP_SPKI_SHA256']);

  for (const bad of [...invalid, ...invalidBackup]) {
    console.warn(`[security] ignoring malformed SPKI pin: ${bad}`);
  }

  const rawMaxAge = source['TLS_PIN_MAX_AGE_SECONDS'];
  const parsedMaxAge = rawMaxAge === undefined ? NaN : Number.parseInt(rawMaxAge, 10);
  const maxAgeSeconds =
    Number.isFinite(parsedMaxAge) && parsedMaxAge > 0 ? parsedMaxAge : DEFAULT_PIN_MAX_AGE_SECONDS;

  return {
    // A client must not hard-fail against an empty pin set, and must not pin a
    // backup-less set either: without a spare key, losing the pinned one
    // bricks every installed app.
    enforced: pins.length > 0 && backupPins.length > 0,
    hosts: parseList(source['TLS_PINNED_HOSTS']),
    pins,
    backupPins,
    maxAgeSeconds,
    reportUri: source['TLS_PIN_REPORT_URI']?.trim() || null,
  };
}
