/**
 * MLS epoch visibility (#372).
 *
 * A device can only derive the key for an MLS group message if its leaf was in
 * the ratchet tree at the epoch that encrypted it. A device added by the commit
 * that produced epoch N therefore reads epoch N onwards and nothing earlier,
 * and a device removed at epoch M stops reading at epoch M.
 *
 * That is a property of MLS, not a bug in the read path — so the read paths
 * hand back a message marked `unavailable` rather than shipping ciphertext the
 * client is guaranteed to fail on. Failed decryption is indistinguishable from
 * tampering on the client, so surfacing it as an error would train users to
 * ignore a signal that is supposed to mean something.
 *
 * These helpers are pure so both the REST history endpoint and the socket
 * `message_history` handler apply exactly the same rule.
 */

/** The epoch interval a device can read: `[joinedAtEpoch, removedAtEpoch)`. */
export interface MlsEpochWindow {
  joinedAtEpoch: number;
  /** Null while the device is still in the group. */
  removedAtEpoch: number | null;
}

/** Stable reason codes clients can branch on for copy. */
export const MLS_UNAVAILABLE_BEFORE_JOIN = 'mls_no_key_before_join';
export const MLS_UNAVAILABLE_AFTER_REMOVAL = 'mls_no_key_after_removal';
export const MLS_UNAVAILABLE_NOT_A_MEMBER = 'mls_not_a_group_member';

export type MlsUnavailableReason =
  | typeof MLS_UNAVAILABLE_BEFORE_JOIN
  | typeof MLS_UNAVAILABLE_AFTER_REMOVAL
  | typeof MLS_UNAVAILABLE_NOT_A_MEMBER;

/**
 * Why a device cannot read `mlsEpoch`, or `null` when it can.
 *
 * `window === null` means the device holds no leaf in the group at all — a
 * device that has been invited but has not yet processed its Welcome, for
 * instance.
 */
export function mlsUnavailableReason(
  mlsEpoch: number,
  window: MlsEpochWindow | null,
): MlsUnavailableReason | null {
  if (window === null) return MLS_UNAVAILABLE_NOT_A_MEMBER;
  if (mlsEpoch < window.joinedAtEpoch) return MLS_UNAVAILABLE_BEFORE_JOIN;
  if (window.removedAtEpoch !== null && mlsEpoch >= window.removedAtEpoch) {
    return MLS_UNAVAILABLE_AFTER_REMOVAL;
  }
  return null;
}

export interface MlsVisibilityFields {
  mlsEpoch?: number | null;
  ciphertext?: string | null;
  envelopes?: unknown[];
}

/**
 * Blanks out the ciphertext of a message the device has no key for and tags it
 * with `unavailable` plus a reason code. Messages with no `mlsEpoch` are not
 * MLS group messages (DMs, system events, pre-MLS history) and pass through
 * untouched, as do messages inside the device's epoch window.
 *
 * Metadata — sender, timestamps, ordering — is deliberately preserved so the
 * client can render a placeholder in the right place in the timeline instead
 * of showing a gap.
 */
export function applyMlsVisibility<T extends MlsVisibilityFields>(
  message: T,
  window: MlsEpochWindow | null,
): T & { unavailable?: true; unavailableReason?: MlsUnavailableReason } {
  const epoch = message.mlsEpoch;
  if (epoch === null || epoch === undefined) return message;

  const reason = mlsUnavailableReason(epoch, window);
  if (reason === null) return message;

  return {
    ...message,
    ciphertext: null,
    ...(message.envelopes === undefined ? {} : { envelopes: [] }),
    unavailable: true as const,
    unavailableReason: reason,
  };
}
