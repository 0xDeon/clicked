/**
 * Device capability/version negotiation (#180-follow-on).
 *
 * `devices.capabilities` is a small JSON document a device advertises at
 * registration and can update later ("upgrade") without re-registering its
 * identity key. It lets a sender pick an encryption path both the sender's
 * and recipient's devices actually support, so new protocols (Signal
 * double-ratchet, MLS group ratchet) can roll out gradually without
 * breaking devices that only understand the original sealed-box/X3DH
 * envelope scheme already in production.
 *
 * Shape:
 *   protocols     — messaging encryption protocols this device can decrypt,
 *                    e.g. ["sealed_box", "signal", "mls"]. "sealed_box" names
 *                    the X3DH + per-device-envelope scheme every device in
 *                    this codebase already implements (devices/messages
 *                    routes) — it is the universal fallback.
 *   ciphersuites  — MLS/Signal ciphersuite identifiers this device supports.
 *                    Only meaningful when "mls" (or a future ciphersuite-
 *                    parameterized protocol) is present in `protocols`.
 *   fileTransfer  — file-encryption scheme versions this device supports,
 *                    e.g. ["file-v1"]. Independent of the messaging protocol.
 *
 * All fields are optional and additional/unrecognized values are preserved
 * but ignored by `selectProtocol` — this is what makes negotiation forward-
 * and backward-compatible: an older server ignores protocol names it
 * doesn't recognize instead of failing, and a device that never advertised
 * capabilities at all (pre-dates this feature) is treated as sealed_box-only.
 */
import { z } from 'zod';

export const KNOWN_PROTOCOLS = ['sealed_box', 'signal', 'mls'] as const;
export type KnownProtocol = (typeof KNOWN_PROTOCOLS)[number];

/** Every device implicitly supports this — it predates the capabilities column. */
export const BASELINE_PROTOCOL: KnownProtocol = 'sealed_box';

/**
 * Preference order used when both sides advertise more than one mutually
 * supported protocol — prefer the strongest/newest scheme available to both.
 */
const PROTOCOL_PRIORITY: readonly KnownProtocol[] = ['mls', 'signal', 'sealed_box'];

export const DeviceCapabilitiesSchema = z
  .object({
    protocols: z.array(z.string()).default([BASELINE_PROTOCOL]),
    ciphersuites: z.array(z.string()).default([]),
    fileTransfer: z.array(z.string()).default([]),
  })
  .partial()
  .default({});

export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

/** The capability set assumed for a device that has never advertised one. */
export const DEFAULT_CAPABILITIES: DeviceCapabilities = {
  protocols: [BASELINE_PROTOCOL],
  ciphersuites: [],
  fileTransfer: [],
};

/**
 * Normalize a possibly-missing/possibly-malformed capabilities value into a
 * concrete `DeviceCapabilities`. Unknown/older clients — including rows from
 * before this column existed (`null`/`undefined`) — fall back to the
 * sealed_box-only baseline rather than erroring, satisfying "unknown/older
 * capabilities handled gracefully".
 */
export function normalizeCapabilities(raw: unknown): DeviceCapabilities {
  const parsed = DeviceCapabilitiesSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ...DEFAULT_CAPABILITIES };

  const protocols = parsed.data.protocols?.length ? parsed.data.protocols : [BASELINE_PROTOCOL];
  return {
    protocols,
    ciphersuites: parsed.data.ciphersuites ?? [],
    fileTransfer: parsed.data.fileTransfer ?? [],
  };
}

/**
 * Pick the best protocol both sides can speak. Falls back to the universal
 * `sealed_box` baseline when there is no other overlap — every registered
 * device supports it, so this never returns `null`.
 */
export function selectProtocol(
  a: unknown,
  b: unknown,
): { protocol: KnownProtocol; ciphersuite: string | null } {
  const capsA = normalizeCapabilities(a);
  const capsB = normalizeCapabilities(b);
  const protocolsA = new Set(capsA.protocols);
  const protocolsB = new Set(capsB.protocols);

  for (const candidate of PROTOCOL_PRIORITY) {
    if (protocolsA.has(candidate) && protocolsB.has(candidate)) {
      const ciphersuite =
        candidate === 'mls' ? selectCiphersuite(capsA.ciphersuites, capsB.ciphersuites) : null;
      return { protocol: candidate, ciphersuite };
    }
  }

  return { protocol: BASELINE_PROTOCOL, ciphersuite: null };
}

/** First ciphersuite identifier both sides advertise, preserving the caller's preference order. */
function selectCiphersuite(a: string[] = [], b: string[] = []): string | null {
  const setB = new Set(b);
  return a.find((suite) => setB.has(suite)) ?? null;
}

/** Whether `capabilities` includes support for the given file-transfer scheme version. */
export function supportsFileTransfer(capabilities: unknown, version: string): boolean {
  return normalizeCapabilities(capabilities).fileTransfer?.includes(version) ?? false;
}
