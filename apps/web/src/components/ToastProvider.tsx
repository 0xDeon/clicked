'use client';

import { PropsWithChildren, useCallback, useMemo, useState } from 'react';
import { ToastContext, type ToastOptions, type ToastVariant } from '@/lib/useToast';

type ToastItem = {
  id: string;
  title?: string;
  message: string;
  variant: ToastVariant;
};

const variantStyles: Record<ToastVariant, string> = {
  success: 'border-emerald-500 bg-emerald-950 text-emerald-100 shadow-emerald-500/20',
  error: 'border-rose-500 bg-rose-950 text-rose-100 shadow-rose-500/20',
  info: 'border-sky-500 bg-sky-950 text-sky-100 shadow-sky-500/20',
};

const variantIcons: Record<ToastVariant, string> = {
  success: '✓',
  error: '⚠',
  info: 'ℹ',
};

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-full max-w-sm flex-col gap-3 px-4 sm:px-0">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-4 overflow-hidden rounded-3xl border p-4 shadow-lg transition-all duration-300 ${variantStyles[toast.variant]}`}
        >
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-lg font-semibold">
            {variantIcons[toast.variant]}
          </div>
          <div className="flex-1">
            {toast.title ? <p className="font-semibold">{toast.title}</p> : null}
            <p className="mt-1 text-sm leading-6 text-current/90">{toast.message}</p>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="ml-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm transition hover:bg-white/20"
            aria-label="Dismiss toast"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((options: ToastOptions) => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    const toast: ToastItem = {
      id,
      title: options.title,
      message: options.message,
      variant: options.variant ?? 'info',
    };

    setToasts((current) => [...current, toast]);

    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(
    () => ({
      notify,
      dismiss,
      success: (message: string, title?: string) => notify({ message, title, variant: 'success' }),
      error: (message: string, title?: string) => notify({ message, title, variant: 'error' }),
      info: (message: string, title?: string) => notify({ message, title, variant: 'info' }),
    }),
    [notify, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
