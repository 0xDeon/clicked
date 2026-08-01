# Push notification subscription flow

## Overview

Clicked uses the Web Push API to deliver real-time notifications. The
subscription flow is managed by `hooks/usePushSubscription.ts` on the client
side, and incoming notifications are handled by the service worker at
`public/sw.js`.

## Step-by-step subscription flow

1. **Service worker registration** — On mount, `usePushSubscription` registers
   `/sw.js` (scope `/`). The service worker calls `skipWaiting()` on install
   and `clients.claim()` on activate so it takes control of all pages
   immediately.

2. **Permission prompt** — The consumer calls `requestSubscription()`. The hook
   calls `Notification.requestPermission()` which shows the browser's
   permission dialog. The result is stored in the `permission` state variable.

3. **VAPID key retrieval** — The VAPID public key is loaded at build time from
   the environment variable `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. The hook converts
   this base64url-encoded key into a `Uint8Array` (via `vapidKeyToUint8Array`)
   as required by the Push API.

4. **Push subscription** — If permission is granted, the hook calls
   `registration.pushManager.subscribe()` with `userVisibleOnly: true` and the
   `applicationServerKey` set to the VAPID key. If a subscription already
   exists (e.g., the user revisited the site), it reuses it to avoid
   duplicates.

5. **Backend registration** — The subscription object (endpoint and keys) is
   serialised and sent as a `POST` to `<API_BASE_URL>/push/subscriptions` with
   an `Authorization: Bearer <token>` header. This is done both during the
   initial `requestSubscription` call and on re-mount if an existing
   subscription is detected (idempotent POST).

## Service worker behaviour

### Push event (`push`)

The push handler in `sw.js` extracts a JSON payload that may contain a
`conversationId` field. It always shows a notification with:

- **Title**: `Clicked`
- **Body**: `You have a new message` (generic, never contains message content)
- **Tag**: `conv-<conversationId>` if a conversation ID is present, otherwise
  `new-message` (allows the browser to replace stale notifications)
- **Data**: `{ conversationId }` — used by the click handler for routing

### Notification click (`notificationclick`)

When the user clicks the notification:

1. The notification is closed.
2. The handler searches for an existing window client on the app's origin.
   - If found, it sends a `postMessage({ type: 'sw:sync', conversationId })` to
     the client and focuses the tab. The React router then syncs the
     conversation data.
   - If no client is found, it opens a new window at
     `/app/conversations/<conversationId>` (or `/app/messages` if no
     conversation ID is available).

## Content-free payloads (design rationale)

Push payloads never contain message text or any user-visible content. The
payload is limited to an optional `conversationId` for routing purposes. The
notification body is always the generic string `You have a new message`.

This design is intentional for two reasons:

- **Privacy** — Push payloads transit through browser vendor push services and
  could be inspected in transit or at rest. Never exposing message content
  limits the blast radius of a compromised push service.
- **Security** — Service worker code is the only code that handles payloads.
  Without message text in the payload, a malformed or malicious push message
  cannot inject content into the notification UI.

Actual message content is fetched by the React app after the user opens or
focuses the app, using the `conversationId` as a reference.
