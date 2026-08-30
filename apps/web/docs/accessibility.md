# Frontend accessibility guide

The accessibility standard `apps/web` targets, and the patterns required to meet it:
keyboard navigation through the conversation list and message composer, focus management
in modals and the safety-number panel, screen-reader announcement of incoming messages,
and colour contrast.

This document describes both the pattern to follow and, honestly, where the current code
already meets it and where it does not yet. Where a gap is called out, treat it as
something to fix when you touch that area, not as the intended design.

---

## Target standard

**WCAG 2.1 Level AA.** This is the conventional baseline for a web application handling
real user-to-user communication, and is the standard assumed throughout this document —
there is no stricter internal bar and no formal deviation from it.

**How it is checked today: manually, not automatically.** There is no `eslint-plugin-jsx-a11y`,
no automated axe/Lighthouse run in CI, and no accessibility test suite in this repo as of
this writing. Conformance currently depends entirely on the patterns below being followed
by hand and reviewed in PRs. If you are adding accessibility tooling, wiring an automated
check (axe-core in CI, or `eslint-plugin-jsx-a11y` at minimum) closes a real gap rather
than adding redundant coverage — until then, the [pre-merge checklist](#pre-merge-checklist-for-a-new-interactive-component)
below is the actual enforcement mechanism.

---

## Keyboard navigation

### Conversation list

`components/conversations/ConversationListSidebar.tsx` renders each conversation as a
plain `<Link>`:

```tsx
<Link href={`/app/conversations/${conversation.id}`} className={/* ... */}>
  {/* avatar, title, preview */}
</Link>
```

There is no custom keyboard handling — no roving `tabindex`, no arrow-key list navigation.
Keyboard support comes entirely from using a real `<Link>` (an anchor): it is naturally
focusable, appears in Tab order, and activates on Enter, all for free. **This is the
required pattern for list items in this app** — a clickable row must be a real
link/button, never a `<div onClick>`, precisely so keyboard support does not have to be
hand-built. Arrow-key roving-tabindex navigation (a full ARIA `listbox`/`menu` pattern) is
not implemented and is not required — sequential Tab order through the list is the
supported navigation model.

### Message composer

The composer (`app/app/conversations/[id]/page.tsx`) supports Enter-to-send /
Shift+Enter-for-newline on the message input:

```tsx
<input
  value={sendText}
  onChange={(e) => setSendText(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendEncrypted();
    }
  }}
/>
```

When adding a keyboard shortcut like this, always `preventDefault()` only on the branch
that consumes the key (here, plain Enter) and let every other key (including Shift+Enter)
fall through untouched — do not swallow keys you are not handling.

The composer's send and attach-file buttons are real `<button>` elements, so they are
independently reachable and activatable by keyboard without any extra wiring — another
instance of the "use the real element" rule above.

**Known gap:** the message input currently has no accessible name beyond its
`placeholder` — placeholder text is not a reliable substitute for a label for
screen-reader users (it disappears on input and many screen readers announce it
inconsistently, if at all). Add `aria-label="Message"` (or a visually-hidden `<label>`) when
next touching this component.

---

## Focus management in modals

### `Modal` — the reference implementation

`components/ui/Modal.tsx` is the pattern every dialog-like component should follow:

- **On open**, it records the element that had focus (`prevFocus.current =
  document.activeElement`) before moving focus into the dialog, and moves focus to the
  first focusable element inside it.
- **While open**, a `Tab`/`Shift+Tab` handler traps focus inside the dialog's content by
  wrapping from the last focusable element back to the first (and vice versa) — focus can
  never leave the dialog via keyboard while it is open.
- **On close**, focus is restored to `prevFocus.current` — whatever triggered the modal
  gets focus back, so a keyboard user is never dropped back at the top of the page.
- **`Escape` closes the dialog**, in addition to the explicit close button.
- The dialog root is marked `role="dialog"` `aria-modal="true"` with an `aria-label` set
  to the dialog's title, so assistive tech announces it as a dialog rather than as
  arbitrary page content.

Any new modal-like UI in this app should be built on top of `Modal`, or replicate all five
of these behaviours (initial focus, trap, restore, `Escape`, `role="dialog"`) if it
genuinely cannot use the shared component.

### The safety-number panel — currently does not meet this bar

The safety-number panel in `app/app/conversations/[id]/page.tsx` (toggled by
`isSafetyOpen`) is a plain `<aside>`, not built on `Modal`:

```tsx
{isSafetyOpen ? (
  <aside className="fixed inset-4 z-50 ...">
    {/* ... */}
  </aside>
) : null}
```

It has no `role="dialog"`, does not move focus into itself on open, does not trap Tab, and
does not restore focus to the triggering element on close. On small screens it is
positioned `fixed inset-4` — visually a modal overlay — which makes the missing focus
management especially misleading: a keyboard or screen-reader user gets a UI that *looks*
modal but behaves like inline content, with focus free to wander back into the
conversation behind it.

**Requirement:** the safety-number panel should either be rebuilt on `Modal`, or gain the
same four behaviours (focus-in on open, Tab trap while open, focus-restore on close,
`role="dialog"`/`aria-modal` when presented as an overlay) directly. This is a known,
tracked gap — do not use the current implementation as a reference pattern for new code.

---

## Live-region announcement of incoming messages

The message thread (`components/messaging/MessageThread.tsx`) is marked as a live region:

```tsx
<div role="log" aria-live="polite" aria-relevant="additions" className="...">
  {messages.map(/* ... */)}
</div>
```

- **`role="log"`** tells assistive tech this is a running log of messages, appropriate for
  a chat transcript (as opposed to `role="status"`, meant for a single transient message).
- **`aria-live="polite"`** — new messages are announced, but politely: the screen reader
  finishes whatever it is currently saying first, rather than interrupting the user
  mid-sentence the way `assertive` would.
- **`aria-relevant="additions"`** scopes announcements to newly added nodes only —
  re-renders that update existing message rows (e.g. a delivery receipt flipping) are not
  re-announced as if they were new messages.
- Critically, **none of this moves focus.** A live region announces via the accessibility
  tree without touching `document.activeElement` — a screen-reader user typing a reply
  keeps their focus in the composer while incoming messages are announced in the
  background. This is the whole point of `aria-live` over any focus-based announcement
  mechanism, and it must not be "fixed" by adding an imperative `.focus()` call anywhere
  in the message-append path.

The typing indicator uses the same pattern at a smaller scope
(`aria-live="polite" aria-atomic="true"` on just the "X is typing…" line), so that
element's *entire* text is re-read on each change rather than only the diffed portion —
appropriate since the whole sentence changes together as the set of typing users changes.

If you add a new kind of ephemeral, non-focused status update to the thread (read
receipts, reactions, presence), model it on the typing indicator: `aria-live="polite"` on
just that element, never on a container that also handles focus.

---

## Colour contrast

The app uses a single dark theme with seven CSS custom-property tokens (see
[Styling — Design tokens](styling.md#2-design-tokens)):

| Token | Value | Role |
| --- | --- | --- |
| `--background` | `#0a0a0f` | Page background |
| `--foreground` | `#f0f0f5` | Primary text |
| `--accent` | `#7c5cfc` | Primary action / brand violet |
| `--accent-light` | `#a78bfa` | Accent text on accent-tinted surfaces |
| `--muted` | `#3f3f50` | Muted surface / de-emphasised element |
| `--card` | `#13131f` | Raised surface |
| `--border` | `#1e1e2e` | Hairline borders and dividers |

`--foreground` on `--background` (`#f0f0f5` on `#0a0a0f`) is very high contrast — no
concern for primary body text. The risk is not the tokens themselves but a very common
idiom throughout the codebase: reducing a token's opacity for de-emphasised text, e.g.
`text-[var(--foreground)]/45`, `/40`, `/35` for timestamps, member counts, and message
previews (see `ConversationListSidebar.tsx`). Because these blend toward the near-black
background rather than toward a lighter grey, a low enough opacity value can drop below
the AA text-contrast threshold (4.5:1 for normal-size text, 3:1 for large/bold text)
without it being obvious from the source alone — the same `/35` reads differently
depending on the surface it sits on (`--background` vs. `--card`).

**Rule:** when introducing a new low-opacity text utility for de-emphasised copy, check
the resulting contrast against whatever surface it actually renders on (page background vs.
card background differ) rather than reusing an opacity value from a nearby line on faith.
Status colours (`Badge.tsx`'s green/amber/red at fixed opacities) carry the same risk and
deserve the same check when reused in a new context.

---

## Pre-merge checklist for a new interactive component

Before merging a new interactive component (anything clickable, focusable, or that changes
content dynamically), confirm:

- [ ] **Real elements for real semantics.** Clickable rows/items use `<a>`/`<Link>` or
  `<button>`, never a `<div>`/`<span>` with an `onClick`. This is what makes Tab order and
  Enter/Space activation work without custom code.
- [ ] **Every interactive control has an accessible name.** A visible text label, an
  `aria-label`, or an `aria-labelledby` — not `placeholder` alone, and not an icon with no
  text or label at all.
- [ ] **If it's a modal/overlay, it is built on `Modal`** (or replicates all of: focus-in
  on open, Tab-trap while open, focus-restore on close, `Escape` to close, `role="dialog"`
  + `aria-modal="true"`). See [Focus management in modals](#focus-management-in-modals).
- [ ] **If it announces dynamic content, it uses `aria-live` without moving focus.** Pick
  `polite` unless the update is genuinely urgent enough to justify interrupting the user;
  scope `aria-relevant`/the live region's DOM extent to just the part that actually
  changes.
- [ ] **Colour is not the only signal.** Anywhere state is conveyed by colour (online/
  offline, verified/unverified, success/error), pair it with an icon, text, or shape —
  check existing components like `Badge` and the safety-number verified check for the
  pattern.
- [ ] **New low-opacity or small text is checked for contrast** against the actual surface
  it renders on (see [Colour contrast](#colour-contrast) above), not assumed from a nearby
  usage.
- [ ] **Keyboard-only pass.** Tab to the new control, operate it fully (open, use, close)
  without touching a mouse, and confirm focus ends up somewhere sensible afterward.
