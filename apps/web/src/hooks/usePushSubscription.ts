'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/api';

// Web Push requires the VAPID key as a Uint8Array in base64url encoding.
function vapidKeyToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/**
 * Issue #349 — the VAPID public key comes from the backend, not a build-time
 * env var. It must match the private key the backend signs pushes with;
 * configuring it separately on the frontend risks silent drift between the
 * two. Returns null (and lets the caller skip push registration) whenever
 * the backend has no key configured or the request fails.
 */
export async function fetchVapidPublicKey(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/push/vapid-public-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { configured: boolean; vapidPublicKey: string | null };
    return data.configured && data.vapidPublicKey ? data.vapidPublicKey : null;
  } catch {
    return null;
  }
}

async function postSubscription(sub: PushSubscription, token: string): Promise<void> {
  const json = sub.toJSON();
  await fetch(`${API_BASE_URL}/push/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
    }),
  });
}

export type PushSubscriptionState = {
  // The current Notification.permission value — 'default' | 'granted' | 'denied'.
  permission: NotificationPermission;
  // True once the subscription has been posted to the server.
  subscribed: boolean;
  // Call this to request permission and subscribe. Safe to call multiple times.
  requestSubscription: () => Promise<void>;
};

export function usePushSubscription(token: string | null): PushSubscriptionState {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'default';
  });
  const [subscribed, setSubscribed] = useState(false);

  // Register the service worker once on mount.
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      return;
    }

    let active = true;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      if (active) setRegistration(reg);
    });

    return () => {
      active = false;
    };
  }, []);

  // Fetch the backend-configured VAPID public key once a token is available.
  useEffect(() => {
    if (!token) return;

    let active = true;
    fetchVapidPublicKey(token).then((key) => {
      if (active) setVapidPublicKey(key);
    });

    return () => {
      active = false;
    };
  }, [token]);

  // Re-use an existing subscription if one already exists.
  useEffect(() => {
    if (!registration || !token || !vapidPublicKey) return;
    if (Notification.permission !== 'granted') return;

    let active = true;
    registration.pushManager.getSubscription().then((existing) => {
      if (!active || !existing) return;
      setSubscribed(true);
      // Ensure server has this subscription (idempotent POST).
      postSubscription(existing, token).catch(() => {});
    });

    return () => {
      active = false;
    };
  }, [registration, token, vapidPublicKey]);

  const requestSubscription = useCallback(async () => {
    if (!registration || !token || !vapidPublicKey) return;

    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== 'granted') return;

    // Reuse an existing subscription to avoid double-posting.
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToUint8Array(vapidPublicKey),
      });
    }

    await postSubscription(sub, token);
    setSubscribed(true);
  }, [registration, token, vapidPublicKey]);

  return { permission, subscribed, requestSubscription };
}
