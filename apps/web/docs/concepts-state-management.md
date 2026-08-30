# Frontend State Management (`apps/web`)

This document describes how client-side state is organized in the Next.js web app: the
React context provider tree, what each context owns, the boundary between in-memory
context state / per-route server state / IndexedDB-persisted state, and why there is no
global store library.

## ⚠️ Known duplication: three `AuthContext` implementations exist

A grep for auth-related context code turns up **three separate implementations**, but
only **one is actually wired up and used**. Read this section before touching auth code.

| Location | Status |
|---|---|
| `src/components/auth/AuthContext.tsx` + `AuthProvider.tsx` + `useAuth.ts` | **Live.** Mounted in `src/app/layout.tsx` (the real root layout) and consumed throughout the app. |
| `src/contexts/AuthContext.tsx` | **Dead code.** Defines its own `AuthContext`/`AuthProvider`/`useAuth` (a more elaborate wallet-challenge sign-in flow that depends on `useWallet`, `apiFetch`, `signWalletMessage`, `getOrCreateDeviceIdentity`). Not imported by any provider tree or any consumer (`grep -rn "contexts/AuthContext"` outside the file itself returns nothing). |
| `src/lib/auth.tsx` | **Dead code, but wired into an unused file.** Defines yet another `AuthContext`/`AuthProvider`/`useAuth` pair. It is imported only by `src/app/providers.tsx`. |
| `src/app/providers.tsx` | **Dead code.** Exports a `Providers` component that wraps `AuthProvider` from `lib/auth.tsx`. Nothing imports `Providers` — it is not referenced from `src/app/layout.tsx` or anywhere else in `src/app`. It looks like an abandoned/earlier attempt at composing providers, superseded by mounting providers directly in `layout.tsx`. |

**The implementation that matters is `src/components/auth/*`.** It is imported by:
`src/app/layout.tsx` (mounts `AuthProvider`), and consumed via `useAuth()` in
`ConversationListSidebar.tsx`, `PushPermissionPrompt.tsx`, `treasury/ProposalCard.tsx`,
`app/app/profile/page.tsx`, `app/app/conversations/[id]/page.tsx`,
`app/app/treasury/page.tsx`, `app/app/devices/page.tsx`, and `components/auth/ProtectedRoute.tsx`.

Everything below documents the **live** system (`components/auth/*` + `contexts/WalletContext.tsx`,
mounted from `src/app/layout.tsx`). The two dead files (`contexts/AuthContext.tsx`,
`lib/auth.tsx`) and the unused `app/providers.tsx` are noted only as cleanup candidates —
do not build on them, and consider deleting them in a follow-up to avoid future confusion
(e.g. an engineer importing `useAuth` from the wrong module and silently getting a
context with a different shape — `token`/`loading` vs. `token`/`user`/`isLoading`/`signIn`/`signOut`).

## Provider tree

The real provider nesting happens in **`src/app/layout.tsx`** (the root layout), not
`app/providers.tsx`:

```tsx
<WalletProvider>
  <AuthProvider>
    <ToastProvider>{children}</ToastProvider>
  </AuthProvider>
</WalletProvider>
```

Outer to inner: **Wallet → Auth → Toast → page tree**.

Why this order matters:

- **`WalletProvider` must be outermost (relative to Auth)** because nothing in the live
  `AuthProvider` (`components/auth/AuthProvider.tsx`) actually depends on wallet state —
  but the codebase's *other* (dead) auth implementation (`contexts/AuthContext.tsx`) does
  call `useWallet()` inside its `signIn()` to get `publicKey`/`connect`. Wallet is placed
  outside Auth so a wallet-driven sign-in flow can call into wallet state without a
  provider-ordering error ("must be used within WalletProvider"). Root layout also
  mounts `WalletProvider` above `AuthProvider` for the same reason `app/app/layout.tsx`
  and `WalletConnectButton.tsx` can call `useWallet()` — wallet identity is the more
  primitive, backend-independent piece of state (it only reflects whether a browser
  extension/wallet is connected), while auth state is derived from a token that in
  principle could depend on the connected wallet address.
- **`AuthProvider` wraps `ToastProvider` and the rest of the app** because route
  components (e.g. `ProtectedRoute`, page-level guards, sidebar/profile components) need
  `useAuth()` available anywhere below it in the tree.
- **`ToastProvider` is innermost** of the three because it is a pure UI-notification
  mechanism with no dependency on auth or wallet state — it only needs to be available
  wherever the app calls a toast, which is "everywhere," so its exact position relative
  to Auth/Wallet has no functional effect; nesting it last simply keeps
  auth/identity-related providers grouped together at the top.

## Auth context (`src/components/auth`)

**State held** (`AuthContext.tsx`):
- `token: string | null` — the JWT/session token.
- `loading: boolean` — true until the initial token read from storage has completed.

**Actions exposed** (`useAuth()` from `useAuth.ts`):
- `setToken(token: string)` — persists the token to `localStorage` under three legacy/alias
  keys (`clicked_token`, `clicked.jwt`, `auth_token`) and updates state.
- `clearToken()` — removes the token from all three storage keys and clears state (sign-out).

**Initialization** (`AuthProvider.tsx`): on mount, reads the first present value across
the three `localStorage` keys, and defers setting it via `requestAnimationFrame` before
flipping `loading` to `false`. This means auth state is **not known synchronously on
first render** — every consumer that gates rendering on auth must wait for `loading`.

**Consumers** (via `useAuth()`):
- `components/auth/ProtectedRoute.tsx` — route gating (see below).
- `components/conversations/ConversationListSidebar.tsx`, `components/PushPermissionPrompt.tsx`,
  `components/treasury/ProposalCard.tsx` — read `token`/`loading` to decide whether to
  fetch user-scoped data or show authenticated UI.
- `app/app/profile/page.tsx`, `app/app/conversations/[id]/page.tsx`,
  `app/app/treasury/page.tsx`, `app/app/devices/page.tsx` — page-level use of the token
  (e.g. to authorize API calls).

## Wallet context (`src/contexts/WalletContext.tsx`)

**State held:**
- `publicKey: string | null` — the connected wallet's public key, or `null` if disconnected.

**Actions exposed** (`useWallet()`):
- `connect(): Promise<string>` — calls `requestWalletAccess()` (Freighter wallet integration
  in `src/lib/freighter`), stores and returns the resulting public key.
- `disconnect(): void` — clears `publicKey`.

**Consumers** (via `useWallet()`):
- `components/wallet/WalletConnectButton.tsx` — the wallet connect/disconnect UI with an
  address dropdown (copy address, edit profile, disconnect).
- `app/app/layout.tsx` — the authenticated app shell's sidebar wallet button.
- The dead `contexts/AuthContext.tsx` also calls `useWallet()`, which is why `WalletProvider`
  is deliberately mounted above `AuthProvider` even though the live `AuthProvider` doesn't
  need it — see "Provider tree" above.

Note: wallet connection state is entirely in-memory (`useState`), not persisted — a page
reload requires reconnecting the wallet, unlike the token, which is persisted to `localStorage`.

## `ProtectedRoute` (`src/components/auth/ProtectedRoute.tsx`)

`ProtectedRoute` wraps a page's children and takes a `mode: 'authenticated' | 'unauthenticated'`
prop:

- `mode="authenticated"`: if there is no `token`, redirects away from the protected page.
- `mode="unauthenticated"`: if there **is** a `token`, redirects away (used on the public
  landing page, `src/app/page.tsx`, to bounce already-authenticated users into the app).

**Redirect mechanism:** `router.replace(...)` from `next/navigation` (`useRouter()`),
inside a `useEffect`. `replace` (not `push`) is used so the redirect doesn't leave the
gated page in browser history. Concretely: `authenticated` mode redirects to `/`;
`unauthenticated` mode (used on the landing page) redirects to `/app`.

**Loading gate:** the effect — and the render — first checks `loading` from `useAuth()`.
While `loading` is `true`, `ProtectedRoute` renders `null` and does not redirect at all.
This exists because `AuthProvider`'s initial token read is asynchronous (deferred one
animation frame) — on first render, before `localStorage` has been checked, `token` is
still `null` even for an already-authenticated user. Without the `loading` gate,
`ProtectedRoute` would see `token === null` on that first render and redirect an
authenticated user away before their real token is loaded — a visible
redirect/flash-of-wrong-content. Gating on `loading` ensures the redirect decision is
only made once the real auth state is known.

## The three layers of client state

1. **React context state (in-memory, per-session UI state)** — `AuthContext` (token,
   loading flag) and `WalletContext` (publicKey). Lives only in memory for the life of
   the tab; reconstructed on reload by re-reading `localStorage` (auth) or requiring a
   fresh wallet connection (wallet). This is the layer for "what is true about the
   current session right now" that many components need without prop-drilling.

2. **Server state fetched per route/page** — most data (conversations, treasury
   proposals, profile, devices) is fetched directly in page/component code via `fetch`/
   `apiFetch` calls (see `src/lib/api.ts` and usage in `app/app/*` pages) rather than
   being normalized into a global client store. Each page is responsible for fetching
   the data it needs, using the `token` from `AuthContext` to authorize the request.
   There is no client-side cache/store (no React Query, SWR, RTK Query, etc. observed)
   — data is refetched per navigation/mount.

3. **IndexedDB-persisted state** — used specifically for data too large, sensitive, or
   structured for `localStorage`/React state:
   - `src/lib/cryptoStore.ts`, `src/lib/prekeyStore.ts`, `src/lib/sessionStore.ts` — raw
     `indexedDB.open(...)` usage for E2E-encryption key material and Signal-style ratchet
     session state (device identity, prekeys, sessions).
   - `src/lib/search/db.ts` — uses the `idb` package (`openDB`/`IDBPDatabase`) for a local
     search index.

   These are deliberately kept **out of React context** — they hold cryptographic
   material and a search index, neither of which needs to trigger re-renders or be
   read synchronously on every render; consumers call into these modules imperatively
   (e.g. during sign-in or when indexing/searching) rather than subscribing to them as
   context.

## Why no global store library (Redux/Zustand/etc.)

`package.json` has no Redux, Zustand, Jotai, Recoil, or MobX dependency — only `idb` for
IndexedDB access. This tracks with the shape of the app's actual state needs: there are
exactly two pieces of cross-cutting session state (auth token, wallet public key), each
naturally scoped to a single React context with a handful of actions; everything else is
either page-local `useState` (e.g. `WalletConnectButton`'s dropdown/connecting/error
state) or server data fetched per route with no need for cross-route sharing or
client-side caching. Two contexts plus a lib-level IndexedDB layer covers the requirement
without introducing a general-purpose store and its associated boilerplate.
