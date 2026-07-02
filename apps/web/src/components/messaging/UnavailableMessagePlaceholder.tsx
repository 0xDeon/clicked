import type { UnavailableReason } from '@/lib/crypto/types';

const REASON_COPY: Record<UnavailableReason, string> = {
  'pre-link': 'Waiting for secure session — message from before this device was linked.',
  undecryptable: 'Unable to decrypt this message.',
  'verification-failed': 'Message could not be verified.',
};

interface UnavailableMessagePlaceholderProps {
  reason: UnavailableReason;
}

/** Graceful placeholder for undecryptable / pre-link messages (#127). */
export function UnavailableMessagePlaceholder({ reason }: UnavailableMessagePlaceholderProps) {
  return (
    <div
      role="note"
      aria-label="Encrypted message unavailable"
      className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)]/60 px-3 py-2 text-sm italic text-[var(--muted)]"
    >
      <span aria-hidden="true" className="mr-1.5">
        🔒
      </span>
      {REASON_COPY[reason]}
    </div>
  );
}
