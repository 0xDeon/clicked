import React from 'react';

export type SkeletonVariant = 'text' | 'avatar' | 'card';

export interface SkeletonLoaderProps {
  variant: SkeletonVariant;
  /**
   * Only used for `variant="text"` — clamps between 1 and 3.
   * Defaults to 2.
   */
  count?: number;
}

function clampCount(value: number | undefined) {
  const n = typeof value === 'number' ? value : 2;
  return Math.max(1, Math.min(3, n));
}

export function SkeletonLoader({ variant, count }: SkeletonLoaderProps) {
  const safeCount = clampCount(count);

  return (
    <>
      {variant === 'text' ? (
        <div className="flex w-full flex-col gap-2">
          {Array.from({ length: safeCount }).map((_, idx) => {
            const widths = [100, 85, 70] as const;
            const width = widths[idx] ?? 70;
            return (
              <div
                key={idx}
                className="clicked-skeleton-pulse h-3 w-full rounded bg-[var(--muted)]/60"
                style={{ width: `${width}%` }}
              />
            );
          })}
        </div>
      ) : null}

      {variant === 'avatar' ? (
        <div
          className="clicked-skeleton-pulse h-10 w-10 rounded-full bg-[var(--muted)]/60"
          aria-hidden="true"
        />
      ) : null}

      {variant === 'card' ? (
        <div className="clicked-skeleton-pulse flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)]/30 p-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-[var(--muted)]/60" />
            <div className="flex-1">
              <div className="h-4 w-3/4 rounded bg-[var(--muted)]/60" />
              <div className="mt-2 h-3 w-full rounded bg-[var(--muted)]/60" />
            </div>
          </div>
          <div className="h-3 w-full rounded bg-[var(--muted)]/60" />
          <div className="h-3 w-5/6 rounded bg-[var(--muted)]/60" />
        </div>
      ) : null}

      <style jsx global>{`
        @keyframes clicked-skeleton-pulse {
          0% {
            opacity: 0.55;
          }
          50% {
            opacity: 0.95;
          }
          100% {
            opacity: 0.55;
          }
        }

        .clicked-skeleton-pulse {
          animation: clicked-skeleton-pulse 1.4s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .clicked-skeleton-pulse {
            animation: none !important;
            opacity: 0.7;
          }
        }
      `}</style>
    </>
  );
}
