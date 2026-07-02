'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/api';

// Loaded at build time — must be set in the environment.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

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

  // Re-use an existing subscription if one already exists.
  useEffect(() => {
    if (!registration || !token || !VAPID_PUBLIC_KEY) return;
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
  }, [registration, token]);

  const requestSubscription = useCallback(async () => {
    if (!registration || !token || !VAPID_PUBLIC_KEY) return;

    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== 'granted') return;

    // Reuse an existing subscription to avoid double-posting.
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await postSubscription(sub, token);
    setSubscribed(true);
  }, [registration, token]);

  return { permission, subscribed, requestSubscription };
}
