// Service worker for Clicked push notifications.
// Scope: / (entire origin).
// Registered by src/hooks/usePushSubscription.ts after the user grants permission.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Push handler — shows a content-free notification.
// The push payload may carry { conversationId } for routing on click,
// but no message text is ever displayed.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // malformed payload — show a generic notification
  }

  const conversationId = data.conversationId ?? null;

  event.waitUntil(
    self.registration.showNotification('Clicked', {
      body: 'You have a new message',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: conversationId ? `conv-${conversationId}` : 'new-message',
      renotify: true,
      data: { conversationId },
    }),
  );
});

// Notification click — focus an open window or open a new one,
// then tell the client to sync the relevant conversation.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const conversationId = event.notification.data?.conversationId ?? null;
  const target = conversationId
    ? `/app/conversations/${conversationId}`
    : '/app/messages';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (new URL(client.url).origin === self.location.origin) {
            // postMessage triggers navigation in the React router; focus brings
            // the tab to the front. navigate() is available only on controlled
            // clients, so we guard before calling it.
            client.postMessage({ type: 'sw:sync', conversationId });
            client.focus();
            return;
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
