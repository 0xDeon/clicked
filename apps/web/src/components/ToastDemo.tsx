'use client';

import { useToast } from '@/lib/useToast';

export function ToastDemo() {
  const { success, error, info } = useToast();

  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto max-w-6xl px-6">
        <div className="rounded-4xl border border-border bg-card p-8 shadow-xl shadow-black/10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-foreground">Feedback demo</h2>
              <p className="mt-2 max-w-2xl text-foreground/70">
                Trigger toast notifications for send errors, copy confirmations, and profile save
                feedback.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => error('Message failed to send. Please try again.', 'Send failed')}
                className="rounded-full bg-rose-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
              >
                Trigger send error
              </button>
              <button
                type="button"
                onClick={() => info('Link copied to clipboard.', 'Copied')}
                className="rounded-full bg-sky-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-400"
              >
                Trigger copy confirmation
              </button>
              <button
                type="button"
                onClick={() => success('Your profile changes have been saved.', 'Profile saved')}
                className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-400"
              >
                Trigger profile save
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
