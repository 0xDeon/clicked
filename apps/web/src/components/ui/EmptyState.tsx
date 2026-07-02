'use client';

import React from 'react';

export interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)]/30 p-6 text-center">
      <div aria-hidden="true" className="text-3xl">
        {icon}
      </div>
      <div className="max-w-md">
        <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--foreground)]/50">{description}</p>
      </div>

      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 inline-flex items-center justify-center rounded-full bg-[var(--accent)] px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-[var(--accent)]/20 transition-opacity hover:opacity-90"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
