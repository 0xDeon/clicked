# UI Primitives (`apps/web/src/components/ui/`)

This document covers the shared UI primitives in `apps/web/src/components/ui/`: `Avatar`, `Badge`, `CopyButton`, `EmptyState`, `Modal`, `ProposalCard`, `SkeletonLoader`, and `Spinner`. For each component: its props, a usage example, whether it's presentational or stateful, any accessibility behavior implemented, and current test coverage. Test coverage was verified by grepping the whole repo for each component name inside `*.test.*` files — `ProposalCard.test.tsx` is the only test file found for any of these eight components.

---

## Avatar

`apps/web/src/components/ui/Avatar.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `src` | `string` | No | `undefined` |
| `fallback` | `string` | Yes | — |
| `size` | `'sm' \| 'md' \| 'lg'` (maps to 24 / 36 / 48px) | Yes | — |
| `online` | `boolean` | No | `undefined` (falsy) |

`fallback` is also used to derive initials (via `getInitials`) and a deterministic background color (via a simple string hash → HSL hue) when no image is shown.

**Usage**

```tsx
<Avatar src={user.avatarUrl} fallback={user.name} size="md" online={user.isOnline} />
```

**Type**: Stateful. Uses `useState` to track a `failedSrc` (so that if the image `onError`s, it falls back to the initials avatar instead of retrying), and `useMemo` to compute initials/color.

**Accessibility**: The outer wrapper has `aria-label="Avatar for {fallback}"`. When an image is shown, its `alt` text is the same `ariaLabel`. The optional online indicator dot has its own `aria-label="Online"`.

**Test coverage**: No test file today.

---

## Badge

`apps/web/src/components/ui/Badge.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `variant` | `'default' \| 'success' \| 'warning' \| 'danger'` | No | `'default'` |
| `children` | `React.ReactNode` | Yes | — |
| `className` | `string` | No | `undefined` |

**Usage**

```tsx
<Badge variant="success">Active</Badge>
```

**Type**: Presentational. A pure function component with no state, effects, or refs — just a `<span>` with variant-based Tailwind classes.

**Accessibility**: None implemented beyond it being a plain inline text element (no `role` or `aria-*` attributes).

**Test coverage**: No test file today.

---

## CopyButton

`apps/web/src/components/ui/CopyButton.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `value` | `string` | Yes | — |
| `className` | `string` | No | `''` |

**Usage**

```tsx
<CopyButton value={wallet.address} className="ml-2" />
```

**Type**: Stateful. Uses `useState` to track a `copied` boolean.

**Accessibility / copied feedback**: The button's `aria-label` and `title` swap between `"Copy address"` / `"Copy to clipboard"` and `"Copied address"` / `"Copied!"` based on the `copied` state. Clicking calls `navigator.clipboard.writeText(value)`; on success it sets `copied` to `true` and shows an animated checkmark icon (via `framer-motion`'s `AnimatePresence`, cross-fading from a Copy icon to a Check icon) in place of the copy icon. The `copied` state is reset back to `false` after **2000ms** (`setTimeout`), reverting to the copy icon/labels. While `copied` is `true`, clicking again is a no-op (`if (copied) return`). Clicks call `e.stopPropagation()` so the button can sit inside a clickable parent (e.g. a card) without triggering the parent's click handler. Clipboard failures are silently swallowed (empty `catch`).

**Test coverage**: No test file today.

---

## EmptyState

`apps/web/src/components/ui/EmptyState.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `icon` | `string` | Yes | — |
| `title` | `string` | Yes | — |
| `description` | `string` | Yes | — |
| `action` | `{ label: string; onClick: () => void }` | No | `undefined` |

**Usage**

```tsx
<EmptyState
  icon="📭"
  title="No proposals yet"
  description="Create a proposal to get started."
  action={{ label: 'New Proposal', onClick: openCreateModal }}
/>
```

**Type**: Presentational. Pure function component, no state or effects.

**Accessibility**: The icon `<div>` is marked `aria-hidden="true"` since it's decorative; the title/description are rendered as a semantic `<h3>`/`<p>` pair. The optional action renders as a real `<button type="button">`.

**Test coverage**: No test file today.

---

## Modal

`apps/web/src/components/ui/Modal.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `isOpen` | `boolean` | Yes | — |
| `onClose` | `() => void` | Yes | — |
| `title` | `string` | Yes | — |
| `children` | `ReactNode` | Yes | — |

**Usage**

```tsx
<Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Confirm Execution">
  <p>Are you sure you want to execute this proposal?</p>
</Modal>
```

**Type**: Stateful. Uses `useState` for a three-phase visibility machine (`'closed' | 'open' | 'closing'`), `useRef` for the content element and for the element that had focus before opening, and several `useEffect`s to drive open/close transitions, focus handling, and body scroll locking. Renders via `createPortal` into `document.body`.

**Accessibility**: This is the most accessibility-featured component in the set:
- Root dialog `<div>` has `role="dialog"`, `aria-modal="true"`, and `aria-label={title}`.
- **Focus trap**: on open, focus moves to the first focusable element inside the modal content (via a `FOCUSABLE` selector list covering links, buttons, inputs, textareas, selects, and `[tabindex]`). A `keydown` listener intercepts `Tab`/`Shift+Tab` at the first/last focusable elements and wraps focus back around, keeping focus inside the modal.
- **Focus restoration**: the element focused before the modal opened (`prevFocus.current`) is refocused once the close animation finishes.
- **Escape to dismiss**: the same `keydown` listener closes the modal (`onClose()`) on `Escape`.
- **Backdrop click to dismiss**: the semi-opaque backdrop `<div>` has an `onClick={onClose}`.
- **Body scroll lock**: `document.body.style.overflow` is set to `'hidden'` while open and restored on close/unmount.
- A visible `Close` button in the header also has `aria-label="Close modal"`.
- The content panel itself has `tabIndex={-1}` so it can programmatically receive focus without becoming part of natural tab order.

**Test coverage**: No test file today.

---

## ProposalCard

`apps/web/src/components/ui/ProposalCard.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `proposal` | `{ id: string; status: ProposalStatus; expiryLedger: number }` | Yes | — |
| `currentLedger` | `number` | Yes | — |
| `isMember` | `boolean` | Yes | — |
| `onExecute` | `(id: string) => void` | Yes | — |
| `onFinalize` | `(id: string) => void` | Yes | — |

`ProposalStatus` is `'pending' | 'approved' | 'executed' | 'rejected' | 'expired'`.

**Usage**

```tsx
<ProposalCard
  proposal={{ id: '42', status: 'approved', expiryLedger: 1200 }}
  currentLedger={1150}
  isMember={true}
  onExecute={(id) => executeProposal(id)}
  onFinalize={(id) => finalizeProposal(id)}
/>
```

**Type**: Stateful. Uses `useState` for `isCollapsed` (defaults to `true` for `executed`/`rejected` proposals) and `timeLeft` (a countdown string), plus a `useEffect` that recomputes the countdown immediately and then every 60 seconds via `setInterval` (cleared on unmount/dependency change). One ledger is treated as ≈5 seconds for the countdown math.

Behavior notes: the status badge color is looked up from a `badgeColors` map keyed by status. The "Execute Withdrawal" button only renders when `status === 'approved' && isMember`. The "Finalize" button only renders when `status === 'expired'`. A collapse/expand toggle ("Show Past Details" / "Hide Details") only appears for `executed`/`rejected` proposals.

**Accessibility**: None explicitly implemented — plain `<div>`/`<button>`/`<span>` elements with no `aria-*` attributes or semantic roles beyond native button/heading semantics (`<h3>`).

**Test coverage**: Yes — `apps/web/src/components/ui/ProposalCard.test.tsx` (the only component in this folder with a dedicated test file). It covers: (1) the Execute button rendering only when `isMember` is true and status is `approved`, verified via `rerender` with `isMember={false}`; (2) the Finalize button rendering for `expired` status instead of the approve/execute controls.

---

## SkeletonLoader

`apps/web/src/components/ui/SkeletonLoader.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `variant` | `'text' \| 'avatar' \| 'card'` | Yes | — |
| `count` | `number` | No | `2` (internally clamped to the range 1–3; only used for `variant="text"`) |

**Usage**

```tsx
<SkeletonLoader variant="card" />
<SkeletonLoader variant="text" count={3} />
```

**Type**: Presentational. Pure function component — no state, effects, or refs. `count` is normalized by a plain helper function (`clampCount`), not stored as state.

**Accessibility**: The `avatar` variant's placeholder `<div>` is marked `aria-hidden="true"`. The `text` and `card` variants have no explicit `aria-*` attributes. A global `<style jsx>` block defines the pulse animation and disables it under `prefers-reduced-motion: reduce` (falling back to a static `opacity: 0.7`).

**Test coverage**: No test file today.

---

## Spinner

`apps/web/src/components/ui/Spinner.tsx`

**Props**

| Name | Type | Required | Default |
|---|---|---|---|
| `size` | `'sm' \| 'md' \| 'lg'` | No | `'md'` |
| `label` | `string` | No | `undefined` |
| `className` | `string` | No | `undefined` |

**Usage**

```tsx
<Spinner size="sm" label="Loading proposals" />
```

**Type**: Presentational. Pure function component — no state or effects; size lookup is a plain object map.

**Accessibility**: When `label` is provided, the spinner element gets `role="status"` and `aria-label={label}`, making it announced to screen readers. When `label` is omitted, it is instead marked `aria-hidden={true}` so assistive tech ignores it entirely. A global `<style jsx>` block defines the spin animation and disables it under `prefers-reduced-motion: reduce`.

**Test coverage**: No test file today.
