import React from 'react';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  default: 'border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent-light)]',
  success: 'border-green-500/30 bg-green-500/15 text-green-300',
  warning: 'border-yellow-500/30 bg-yellow-500/15 text-yellow-200',
  danger: 'border-red-500/30 bg-red-500/15 text-red-300',
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-none ${VARIANT_CLASS[variant]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
