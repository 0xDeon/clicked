# Tailwind & styling conventions

How styling works in `apps/web`: the Tailwind v4 setup, where global styles live,
the design tokens that are actually in use, the breakpoints in play, and the
conventions for writing and extracting classes.

---

## 1. Setup

| Thing             | Value                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Tailwind version  | **v4** — `tailwindcss: ^4` and `@tailwindcss/postcss: ^4` in [`package.json`](../package.json) |
| Config file       | **None.** There is no `tailwind.config.js`/`.ts`. v4 configures itself from CSS.               |
| PostCSS           | [`postcss.config.mjs`](../postcss.config.mjs), one plugin: `@tailwindcss/postcss`              |
| Global stylesheet | [`src/app/globals.css`](../src/app/globals.css), imported once from `src/app/layout.tsx`       |
| Framework         | Next.js 16 App Router, React 19                                                                |
| Fonts             | `Geist` and `Geist_Mono` via `next/font/google`, wired in `layout.tsx`                         |

```js
// postcss.config.mjs — the entire build-side setup
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```

The v4 detail worth internalising: **there is no JavaScript config to edit.**
Theme extension happens in CSS via `@theme`, and content scanning is automatic —
you do not maintain a `content: []` array. If you reach for
`tailwind.config.js`, you are working against the setup.

### Global styles

`globals.css` is short and holds everything global:

```css
@import 'tailwindcss';

:root {
  --background: #0a0a0f;
  --foreground: #f0f0f5;
  --accent: #7c5cfc;
  --accent-light: #a78bfa;
  --muted: #3f3f50;
  --card: #13131f;
  --border: #1e1e2e;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-accent: var(--accent);
  --color-accent-light: var(--accent-light);
  --color-muted: var(--muted);
  --color-card: var(--card);
  --color-border: var(--border);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans), Arial, Helvetica, sans-serif;
}

html {
  scroll-behavior: smooth;
}
```

Two layers, and the difference matters:

- The `:root` block declares the **raw CSS variables**. These are what
  `[var(--accent)]` reads.
- The `@theme inline` block maps those into **Tailwind's theme namespace**, which
  is what generates utilities like `bg-accent`, `text-foreground`, and
  `border-border`.

Both layers exist, so both idioms work. See
[§3](#3-two-ways-to-reach-a-token-and-when-to-use-each).

Anything not global belongs in a component. The only component-level CSS in the
codebase is styled-jsx in
[`Spinner.tsx`](../src/components/ui/Spinner.tsx) and
[`SkeletonLoader.tsx`](../src/components/ui/SkeletonLoader.tsx), both for
keyframe animations that utilities cannot express — including a
`prefers-reduced-motion` guard. That is the bar for reaching past utilities:
**a keyframe or a media query Tailwind has no utility for.**

---

## 2. Design tokens

Seven colour tokens, all defined in `globals.css`. There is no secondary palette,
no semantic status colours in the theme, and no spacing or typography tokens
beyond Tailwind's built-in scales.

| Token            | Value     | Role                                    | In use |
| ---------------- | --------- | --------------------------------------- | ------ |
| `--background`   | `#0a0a0f` | Page background — near-black, blue-cast | ~23    |
| `--foreground`   | `#f0f0f5` | Primary text                            | ~143   |
| `--accent`       | `#7c5cfc` | Primary action / brand violet           | ~71    |
| `--accent-light` | `#a78bfa` | Accent text on accent-tinted surfaces   | ~10    |
| `--muted`        | `#3f3f50` | Muted surface / de-emphasised element   | ~15    |
| `--card`         | `#13131f` | Raised surface — cards, panels          | ~42    |
| `--border`       | `#1e1e2e` | Hairline borders and dividers           | ~71    |

Counts are utility occurrences across `src/**/*.tsx`, summing both idioms in
[§3](#3-two-ways-to-reach-a-token-and-when-to-use-each). They are here to show
which tokens carry the UI, not as a target.

**Status colours are not tokens.** Success, warning, and danger use Tailwind's
stock palette at fixed opacities, established by
[`Badge.tsx`](../src/components/ui/Badge.tsx):

```ts
const VARIANT_CLASS: Record<BadgeVariant, string> = {
  default: 'border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent-light)]',
  success: 'border-green-500/30 bg-green-500/15 text-green-300',
  warning: 'border-yellow-500/30 bg-yellow-500/15 text-yellow-200',
  danger: 'border-red-500/30 bg-red-500/15 text-red-300',
};
```

That `/30` border, `/15` fill, `-300` text recipe is the house style for a tinted
status surface. Reuse `<Badge>` rather than re-deriving it.

### Spacing

No custom spacing scale — Tailwind's default. What the existing screens actually
use, in descending frequency:

| Purpose           | Values in use                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Control padding   | `px-4 py-2` (most common), `px-3 py-2`, `px-5 py-2`, `px-6 py-3`                           |
| Container padding | `p-6` for cards and panels, `p-4` and `p-5` for tighter ones, `p-3`/`p-2` for compact rows |
| Flex/grid gaps    | `gap-3` (most common), then `gap-4`, `gap-2`, `gap-1`, `gap-6`                             |
| Vertical rhythm   | `space-y-4`, then `space-y-3`                                                              |
| Section padding   | `py-32` on landing sections                                                                |

Stay on this ladder — `2 / 3 / 4 / 6` covers nearly everything. Reach for an
arbitrary value only when matching a specific visual, and prefer the nearest step
otherwise.

### Typography

Two families, both from `next/font/google` and exposed through `@theme` as
`--font-sans` and `--font-mono`. `body` sets sans by default, so `font-sans` is
rarely written explicitly; `font-mono` is for addresses, hashes, and amounts.

| Scale                | Where it is used                                                            |
| -------------------- | --------------------------------------------------------------------------- |
| `text-xs`            | Metadata, timestamps, badge-adjacent labels — very common                   |
| `text-sm`            | **The default for body and UI copy** — the most-used size by a wide margin  |
| `text-base`          | Rare; `text-sm` is the norm, so reaching for `base` is a deliberate step up |
| `text-lg`            | Sub-headings and emphasised rows                                            |
| `text-xl`–`text-3xl` | Section and page headings; `text-3xl` is the common heading size            |
| `text-4xl`+          | Landing page hero only                                                      |

| Weight          | Use                                                      |
| --------------- | -------------------------------------------------------- |
| `font-semibold` | The default for anything emphasised — most common by far |
| `font-medium`   | Softer emphasis, secondary labels                        |
| `font-bold`     | Headings and hero copy                                   |

Normal body text carries no weight class. If you find yourself writing
`font-normal`, something upstream is over-weighted.

### Radius

`rounded-full` (pills, avatars, badges) and `rounded-lg` dominate, with
`rounded-2xl` for cards and panels and `rounded-xl` for medium controls. Prefer
`rounded-2xl` for a new card and `rounded-full` for a new pill or button — that
is what surrounding screens do.

### De-facto tokens that are not in `globals.css`

Two things recur without being declared, and both are worth knowing before you
copy them:

- **Opacity-modified tokens.** `bg-[var(--card)]/30`,
  `text-[var(--foreground)]/50`, `border-[var(--accent)]/30` are used constantly
  to derive a surface or a muted text colour from an existing token. This is
  preferred over inventing a new colour: it stays on-palette automatically.
- **Off-token colours.** About 30 occurrences of `gray-*`/`slate-*` and a handful
  of raw hex values (`[#13131f]`, `[#0F172A]`, `[#0C3F51]`) exist, mostly in
  older components — `CopyButton.tsx` is entirely on a light-mode grey palette
  that does not belong to this theme. **These are drift, not precedent.** Use the
  tokens for new work, and prefer `[#13131f]` → `[var(--card)]` when you are
  already editing a file that has one.

---

## 3. Two ways to reach a token, and when to use each

Because `globals.css` declares both the raw variables and the `@theme` mapping,
both of these compile and both appear in the codebase:

```tsx
<div className="bg-card text-foreground border-border" />        {/* theme utility */}
<div className="bg-[var(--card)] text-[var(--foreground)]" />    {/* arbitrary value */}
```

The arbitrary-value form is roughly twice as common in the current tree
(~193 occurrences vs ~107). Neither is wrong. Pick on this basis:

- **Need an opacity modifier?** Use `[var(--token)]/NN`. This is why the
  arbitrary form dominates — `bg-[var(--card)]/30` has no short theme-utility
  equivalent here.
- **Plain, full-opacity colour?** Either works; `bg-card` is shorter and reads
  better.
- **Editing an existing file?** Match what that file already does. Mixing both
  idioms inside one `className` is the thing to avoid.

---

## 4. Responsive breakpoints

Tailwind's defaults, unmodified: `sm` 640px, `md` 768px, `lg` 1024px, `xl`
1280px, `2xl` 1536px.

Only `sm`, `md`, and `lg` are used. There are **zero** `xl:` or `2xl:`
occurrences in `src/`, so the widest layout you can currently rely on having been
designed is the `lg` one. `max-w-6xl` is the usual page container cap.

The codebase is **mobile-first**: base classes describe the narrow layout and
breakpoint prefixes widen it. Follow that — never write a desktop base and narrow
it with `max-*` variants.

Established patterns:

| Pattern                | Examples in use                                                           |
| ---------------------- | ------------------------------------------------------------------------- |
| Grid columns           | `sm:grid-cols-2`, `md:grid-cols-2/3/5`, `lg:grid-cols-3/4/5`              |
| Progressive disclosure | `hidden md:inline`, `hidden sm:flex`, `hidden md:flex`, `hidden lg:block` |
| Container width        | `max-w-6xl` for page shells; `max-w-sm`/`md`/`lg` for cards and dialogs   |

Chat and conversation views assume a working narrow layout, so test any change
there at a phone width before a desktop one.

---

## 5. Class ordering

**Nothing enforces class order.** There is no `prettier-plugin-tailwindcss` in
[`package.json`](../../../package.json) and no Tailwind ESLint rule in
[`eslint.config.mjs`](../eslint.config.mjs) — the config is
`eslint-config-next` core-web-vitals plus TypeScript, nothing more. Ordering is a
convention you follow by hand, and no CI job will correct you.

The order the existing components follow, and the one to write:

1. **Layout & display** — `flex`, `grid`, `inline-flex`, `hidden`, `block`
2. **Box model / sizing** — `h-full`, `w-full`, `min-h-40`, `max-w-md`
3. **Flex & grid children** — `items-center`, `justify-between`, `flex-col`, `gap-3`
4. **Spacing** — `p-6`, `px-4`, `py-2`, `mt-2`, `space-y-4`
5. **Border & radius** — `rounded-2xl`, `border`, `border-dashed`, `border-[var(--border)]`
6. **Background** — `bg-[var(--card)]/30`
7. **Typography** — `text-sm`, `font-semibold`, `leading-relaxed`, `text-[var(--foreground)]`
8. **Effects** — `shadow-lg`, `blur-[120px]`, `transition-opacity`
9. **State & responsive variants last** — `hover:opacity-90`, `focus:ring-2`, `md:inline`, `lg:grid-cols-3`

[`EmptyState.tsx`](../src/components/ui/EmptyState.tsx) is a clean reference:

```tsx
className =
  'flex h-full min-h-40 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)]/30 p-6 text-center';
```

Keeping variants at the end matters most in practice — it makes the base
(mobile) layout readable in one glance.

---

## 6. When to extract a component

There is **no `cn()`/`clsx`/`tailwind-merge` helper** in this codebase. Classes
are composed with template literals and an appended `className` prop:

```tsx
className={`... base classes ... ${VARIANT_CLASS[variant]} ${className ?? ''}`}
```

Follow that pattern rather than introducing a class-merging utility for a single
component; if one is added, it should land as its own change with every call site
converted.

### Extract when

- **The same cluster appears three or more times.** Two occurrences are a
  coincidence; three is a component. The tinted-pill recipe hit that bar and
  became `<Badge>`.
- **It has variants.** The moment you write a conditional that picks between
  class strings, that belongs in a `Record<Variant, string>` map inside a
  component — the shape `Badge` and `Spinner` both use.
- **It carries accessibility or behaviour.** `Spinner` exists as much for its
  `role="status"`/`aria-hidden` logic and reduced-motion handling as for its
  look. Anything with ARIA, focus management, or an animation should not be
  copy-pasted.
- **It needs non-utility CSS.** Keyframes or a media query utilities cannot
  express force a component boundary anyway.
- **It is a recognisable UI noun.** Avatar, badge, modal, empty state, skeleton,
  spinner — if you can name it, it belongs in
  [`src/components/ui/`](../src/components/ui/).

### Repeat the utilities when

- **It is used once or twice.** Do not build an abstraction for a single caller.
- **The variation is layout, not identity.** A card that is `p-4` here and `p-6`
  there with a different grid is two layouts, not one component with two props.
- **Extracting would need more props than the classes it saves.** A wrapper
  taking six props to configure spacing is worse than the spacing.
- **It is page-specific composition.** Section layout in a route belongs in that
  route.

### Where components live

| Directory                                     | Contents                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`src/components/ui/`](../src/components/ui/) | Generic primitives — `Avatar`, `Badge`, `CopyButton`, `EmptyState`, `Modal`, `ProposalCard`, `SkeletonLoader`, `Spinner`    |
| `src/components/<feature>/`                   | Feature-scoped components — `auth/`, `chat/`, `conversations/`, `landing/`, `messaging/`, `search/`, `treasury/`, `wallet/` |

A component reused across two features moves to `ui/`; one that knows about a
domain type stays in its feature directory.

---

## 7. Dark mode

**There is no dark-mode support, and there is nothing to toggle.** The app is
**dark-only** by design:

- The single `:root` palette in `globals.css` _is_ the dark theme — `#0a0a0f`
  background, `#f0f0f5` foreground. There is no light palette anywhere.
- There is **no `@media (prefers-color-scheme: ...)` block** in the codebase.
- There is **no `darkMode` configuration** — v4 would configure it in CSS via a
  custom variant, and none is declared.
- There is **no theme provider, no `next-themes`, and no theme toggle.**
  `layout.tsx` wraps the tree in `WalletProvider`, `AuthProvider`, and
  `ToastProvider` only.
- `<html>` carries no `class="dark"` or `data-theme` attribute.

Exactly **one** `dark:` variant exists in the whole of `src/` —
`text-emerald-600 dark:text-emerald-500` in
[`CopyButton.tsx`](../src/components/ui/CopyButton.tsx). Because no dark-mode
strategy is configured, **that variant never activates.** It is a leftover from a
component authored against light-mode assumptions, which is also why that file
uses `slate-50`, `gray-100`, and `#0C3F51` — colours that belong to no theme
here.

Consequences for new work:

- **Do not write `dark:` variants.** They are dead code. Style for the dark
  palette directly.
- **Do not assume a light background.** A component built with light-mode
  defaults will be illegible; `CopyButton` is what that looks like in practice.
- **Adding light mode is a project, not a patch.** It would need a light palette,
  a variant strategy declared in `globals.css`, a theme provider with persistence,
  and an audit of every hardcoded colour listed in
  [§2](#de-facto-tokens-that-are-not-in-globalscss). Nothing today is written to
  support it.

---

## 8. Checklist for a new component

- [ ] Colours come from the seven tokens — theme utility or `[var(--token)]`, with `/NN` for tints. No new raw hex, no `gray-*`/`slate-*`.
- [ ] Spacing is on the `2 / 3 / 4 / 6` ladder; padding matches the `px-4 py-2` / `p-6` conventions.
- [ ] Type is `text-sm` unless there is a reason; emphasis is `font-semibold`.
- [ ] Radius matches neighbours — `rounded-2xl` for cards, `rounded-full` for pills.
- [ ] Written mobile-first, with `sm:`/`md:`/`lg:` widening it. No `xl:`/`2xl:` unless you are also designing that width.
- [ ] Classes ordered per [§5](#5-class-ordering); variants last.
- [ ] No `dark:` variants.
- [ ] Third occurrence of the same cluster? Extract it to `src/components/ui/`.
- [ ] Non-utility CSS is styled-jsx inside the component, with a `prefers-reduced-motion` guard on any animation.

---

## 9. Related documents

- [Wallet & treasury UI](./concepts-wallet-treasury-ui.md) — the screens most of these conventions were established on
- [Auth & device lifecycle](./concepts-auth-device-lifecycle.md)
- [Message pipeline](./concepts-message-pipeline.md) — the chat views to test at narrow widths
- [`src/app/globals.css`](../src/app/globals.css) — the source of truth for every token above
