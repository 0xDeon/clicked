'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/useAuth';
import { usePushSubscription } from '@/hooks/usePushSubscription';

const DISMISSED_KEY = 'clicked.push.dismissed';

// Shown contextually inside the authenticated app shell, not on first page load.
// Appears 5 seconds after the component mounts (i.e. after the user navigates
// into the app), and is suppressed once the user dismisses or grants permission.
export function PushPermissionPrompt() {
  const { token } = useAuth();
  const { permission, subscribed, requestSubscription } = usePushSubscription(token);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!token) return;
    if (permission !== 'default') return;
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DISMISSED_KEY)) return;

    const timer = setTimeout(() => setVisible(true), 5000);
    return () => clearTimeout(timer);
  }, [token, permission]);

  function dismiss() {
    setVisible(false);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  }

  async function enable() {
    await requestSubscription();
    setVisible(false);
  }

  // Hide when not visible, permission already decided, or already subscribed.
  if (!visible || permission !== 'default' || subscribed) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-6 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 items-start gap-4 rounded-2xl border border-border bg-card p-4 shadow-xl"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Enable notifications</p>
        <p className="mt-0.5 text-xs text-foreground/60">
          Get alerted when a new message arrives, even when the tab is in the background.
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <button
          onClick={enable}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-light"
        >
          Enable
        </button>
        <button
          onClick={dismiss}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-foreground/50 transition-colors hover:text-foreground"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
