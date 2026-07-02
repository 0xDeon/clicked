'use client';

import { createContext, useContext } from 'react';

type ToastVariant = 'success' | 'error' | 'info';

export type ToastOptions = {
  message: string;
  title?: string;
  variant?: ToastVariant;
};

export type ToastContextValue = {
  notify: (options: ToastOptions) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used inside ToastProvider');
  }

  return context;
}

export { ToastContext };
export type { ToastVariant };
