import React from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  /**
   * Accessible label for screen readers.
   * When omitted, the spinner is marked as aria-hidden.
   */
  label?: string;
  className?: string;
}

const SIZE_MAP: Record<SpinnerSize, { px: number; borderPx: number }> = {
  sm: { px: 16, borderPx: 2 },
  md: { px: 24, borderPx: 3 },
  lg: { px: 32, borderPx: 4 },
};

export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  const { px, borderPx } = SIZE_MAP[size];

  return (
    <>
      <span
        role={label ? 'status' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        className={`clicked-spinner inline-block align-middle ${className ?? ''}`}
        style={{
          width: px,
          height: px,
          borderWidth: borderPx,
        }}
      />
      <style jsx global>{`
        @keyframes clicked-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .clicked-spinner {
          border-style: solid;
          border-radius: 9999px;
          border-color: rgba(240, 240, 245, 0.25);
          border-top-color: currentColor;
          animation: clicked-spin 0.9s linear infinite;
          will-change: transform;
          transform: translateZ(0);
        }

        @media (prefers-reduced-motion: reduce) {
          .clicked-spinner {
            animation: none !important;
          }
        }
      `}</style>
    </>
  );
}
