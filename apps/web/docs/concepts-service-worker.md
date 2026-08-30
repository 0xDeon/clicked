# Service worker and offline behaviour

This document covers `public/sw.js`: how it is registered and updated, what it does with
push events, how it routes notification clicks back into the app, and — plainly — what
does and does not work when the device is offline.

For the push *subscription* flow (permission prompt, VAPID keys, backend registration),
see [Push notification subscription flow](concepts-push-subscription.md). This document
focuses on the service worker itself.

---

## Registration lifecycle

The service worker is registered by `hooks/usePushSubscription.ts`, not by Next.js or a
PWA plugin — there is no automatic registration on every page load. Registration happens
on mount of whatever component calls `usePushSubscription`:

```ts
navigator.serviceWorker.register('/sw.js', { scope: '/' });
```

Scope `/` means the worker controls every page on the origin, not just the page that
registered it.

### Install and activate

```js
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
```

- **`install` → `skipWaiting()`** — By default, a newly installed service worker sits in a
  "waiting" state until every open tab controlled by the old worker is closed. Calling
  `skipWaiting()` during install skips that wait: the new worker activates as soon as it
  finishes installing, even while old tabs are still open.
- **`activate` → `clients.claim()`** — By default, an activated worker only controls pages
  loaded *after* activation. `clients.claim()` takes control of every already-open,
  uncontrolled page on the origin immediately.

### The update path — how a stale worker is replaced

Together, `skipWaiting()` + `clients.claim()` mean this service worker updates itself
eagerly rather than waiting for a natural refresh cycle:

1. The browser fetches `/sw.js` on navigation/periodically and byte-compares it against the
   currently installed worker.
2. If it differs, the browser installs the new version in the background. `install` fires,
   `skipWaiting()` runs immediately, and the new worker moves straight to "activating"
   instead of "waiting".
3. `activate` fires, `clients.claim()` runs, and the new worker takes over **every open
   tab** on the origin — including ones that were loaded under the old worker and never
   reloaded.

The practical effect: there is no user-visible "a new version is available, refresh to
update" step for the service worker itself. The trade-off is that a page whose in-memory
JS was loaded under the old worker can, in principle, keep running while a different tab
is now served by the new worker — the two do not roll forward in lockstep mid-session.
Since this worker carries no versioned caching logic (see [Offline behaviour](#offline-behaviour-today)
below), this has not been a practical problem: there is no cached asset list that could
go stale between the two workers.

---

## The push handler

```js
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
```

### Content-free by design

The notification title is always the literal string `Clicked`, and the body is always the
literal string `You have a new message`. The only thing extracted from the push payload is
an optional `conversationId`, used purely for click-routing (see below) — it is never
rendered into the notification UI. A malformed or unparsable payload is caught and still
produces a generic notification rather than failing silently.

This is the client-side half of a deliberate privacy design: the backend never puts message
content in a push payload in the first place. See
[`apps/backend/docs/api-push.md`](../../backend/docs/api-push.md) for how the backend
constructs push payloads and why content is excluded server-side. The two halves only work
together — a service worker that refuses to render content is not a substitute for a
backend that never sends it, and vice versa.

`tag: conv-<conversationId>` (or `new-message` when there is no conversation ID) lets a
second push for the same conversation replace the existing OS notification instead of
stacking a duplicate; `renotify: true` re-alerts the user when that replacement happens.

---

## Notification click routing

```js
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
            client.postMessage({ type: 'sw:sync', conversationId });
            client.focus();
            return;
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
```

1. The clicked notification is closed immediately.
2. The worker looks for any open window on the app's origin via
   `clients.matchAll({ type: 'window', includeUncontrolled: true })`.
3. **If one is found**, the worker does **not** navigate it directly — `postMessage` and
   `navigate()` on a `WindowClient` both require the client to be controlled, and an
   `includeUncontrolled` match may not be. Instead it posts `{ type: 'sw:sync',
   conversationId }` to the page and calls `client.focus()` to bring the existing tab to
   the front. The app's own layout listens for this message client-side:

   ```ts
   // apps/web/src/app/app/layout.tsx
   navigator.serviceWorker.addEventListener('message', (event) => {
     if (event.data?.type !== 'sw:sync') return;
     const { conversationId } = event.data;
     router.push(conversationId ? `/app/conversations/${conversationId}` : '/app/messages');
   });
   ```

   The Next.js router then performs the actual client-side navigation. This is the
   "focus an existing tab rather than opening a duplicate" behaviour — a user with the app
   already open in one tab never ends up with a second tab per notification.
4. **If no window is found**, the worker calls `self.clients.openWindow(target)`, opening a
   fresh tab directly at `/app/conversations/<id>` (or `/app/messages` with no ID) — there
   is no existing page to `postMessage` into, so the destination URL does the routing work
   instead.

---

## Offline behaviour today

This service worker registers no `fetch` handler and maintains no `caches` entries. It
exists solely for push notifications (`push`, `notificationclick`) and its own lifecycle
(`install`, `activate`). Concretely:

**Works offline:**

- Previously loaded pages that are still in the browser's own HTTP cache or Next.js's
  client-side router cache may continue to render from memory until a hard navigation is
  needed.
- Already-decrypted messages held in IndexedDB (see
  [IndexedDB schemas](contracts-indexeddb-schemas.md)) remain readable if a view reads from
  local storage rather than the network.
- Push notifications continue to be received and shown while offline is not the relevant
  condition here — push delivery is the browser vendor's push service waking the service
  worker, independent of whether the tab is open.

**Does not work offline:**

- No page, route, or static asset is precached — a hard reload or first navigation to an
  unvisited route while offline fails exactly as it would with no service worker at all.
- No API requests are intercepted or served from a cache; `fetch` calls to the REST API and
  the WebSocket connection simply fail offline (see
  [Frontend error handling and user feedback](concepts-error-handling.md) for how those
  failures surface to the user).
- There is no background sync / outbox queue — a message typed while offline is not queued
  by the service worker for later delivery.
- Nothing is precached ahead of going offline, so there is no "app shell" guarantee — this
  is not a full offline-first PWA today.
