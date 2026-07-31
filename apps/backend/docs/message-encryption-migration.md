# Message encryption migration: plaintext → ciphertext-only

This document is the canonical reference linked from `GET /conversations/:id/search`'s
410 response and from the schema-overhaul audit — it records the decision behind
`drizzle/0003_ciphertext_only_messages.sql` and the policy for any plaintext that
existed before it.

## Background

Earlier in this project's history, `messages` carried a plaintext `content` column
(plus a GIN index supporting server-side search) alongside the work to move to
per-recipient E2EE envelopes (`message_envelopes`) and a `ciphertext` column on
`messages` itself. `docs/e2ee-onboarding.md` documents the current, implemented
E2EE data model; this document covers the one-time cutover away from the old
plaintext column and what happens to data that predates it.

Server-side message search was removed as part of this cutover — the server
cannot search ciphertext it cannot read, so `GET /conversations/:id/search` now
returns `410 Gone` pointing here, and search is client-side over decrypted
messages.

## Decision: archive-then-purge (not a tombstone)

Two options were considered for handling rows where `messages.content` is
non-null at migration time:

1. **Tombstone in place** — keep a `content`-shaped column (or a
   `legacyPlaintext` column) on `messages` forever, nulled out or flagged, so
   the "this row used to be plaintext" fact stays attached to the row.
2. **Archive then purge** (chosen) — copy every non-null `content` value into
   a separate `message_content_archive` table, then drop the column from
   `messages` entirely.

**Archive-then-purge was chosen** because:

- It keeps `messages` fully ciphertext-shaped going forward. Every code path
  that reads a message (`serializeMessage()` in `lib/messages.ts`, the
  `conversations`/`messages` routes, the socket layer) only ever has a
  `ciphertext` branch to reason about — there is no lingering plaintext
  branch that a future change could accidentally serve to a client as if it
  were normal ciphertext.
- `message_content_archive` has **no route or query path through the app's
  API** (see `db/schema.ts` — the table is defined but never imported by
  anything in `routes/`, `services/`, or `socket/`). It exists purely for
  legal/compliance/audit access on its own retention schedule, separate from
  the live message store's.
- It avoids growing the "hot path" `messages` table with a rarely-needed
  legacy column and its GIN index indefinitely.

The rejected tombstone approach was ruled out because it permanently taxes
every future `messages` migration and query with a legacy-shaped column for
data that, by definition, existed only before this cutover and will never
grow again.

## No silent E2EE claim over old plaintext

Rows whose plaintext was archived are **not** presented to clients as if they
were ciphertext. Once `content` is dropped, `serializeMessage()`'s existing
fallback chain (envelope → base `ciphertext` → `unavailable: true`) means a
pre-cutover row with no `ciphertext` and no matching envelope now correctly
resolves to `{ ciphertext: null, unavailable: true }` — the client sees the
message as unavailable rather than being shown a decrypted-looking payload
that was, in fact, sent before E2EE existed. Nothing in this migration
retroactively re-encrypts old plaintext or backdates an "encrypted" claim
onto it.

## What the forward migration does

`drizzle/0003_ciphertext_only_messages.sql`:

1. Creates `message_content_archive` (id, `original_message_id` — intentionally
   **not** a foreign key, so hard-deleting a `messages` row never cascades
   into the archive — `conversation_id`, `sender_id`, `content`,
   `original_created_at`, `archived_at`).
2. If (and only if) `messages.content` still exists — checked dynamically via
   `information_schema.columns`, since a plain SQL statement referencing a
   column that doesn't exist fails to parse — copies every non-null row into
   the archive.
3. Drops the column's GIN index. The exact index name from before this
   repo's migration history was squashed to a single `0000` migration is not
   recoverable, so several plausible historical names are dropped
   defensively with `DROP INDEX IF EXISTS` (a no-op for any name that
   doesn't match).
4. Drops `messages.content` with `DROP COLUMN IF EXISTS` — a no-op on a
   database that never had it, which is the case for this repo's own `0000`
   migration.
5. Defensively ensures the ciphertext-model columns/tables (`messages.ciphertext`,
   `senderDeviceId`, `fileId`, `editsMessageId`, `deletedAt`,
   `message_envelopes`) exist, for any database whose applied-migration
   history predates the `0000` squash. On every database that already ran
   `0000` this is a pure no-op.

This makes the migration safe to run both against this repo's current
(already-ciphertext) schema and against a hypothetical legacy database that
still has the old plaintext column and a populated `messages` table.

## Rollback plan

`drizzle-kit` has no built-in down-migration runner, so the rollback lives at
`drizzle/rollback/0003_ciphertext_only_messages.down.sql` and is invoked
manually, e.g.:

```sh
psql "$DATABASE_URL" -f apps/backend/drizzle/rollback/0003_ciphertext_only_messages.down.sql
```

It:

1. Re-adds `messages.content` (nullable).
2. Recreates a GIN full-text index over it.
3. Restores plaintext from `message_content_archive` back into `messages.content`
   for every row the archive has a match for.

**Rollback limitations** (also called out at the top of the script itself):

- Only rows present in the archive get plaintext restored. Any message sent
  *after* the forward migration ran was only ever stored as ciphertext —
  there is nothing to restore for it, by design.
- The recreated index is a reasonable equivalent, not necessarily
  byte-identical to whatever definition existed pre-squash.
- The rollback does **not** remove the ciphertext/envelope/device-capability/
  GC schema this migration set introduces — undoing those would remove the
  entire E2EE data model, which is a separate, deliberate decision this
  script does not make on an operator's behalf.
- `message_content_archive` is left in place after a rollback (nothing is
  destroyed); drop it manually once you're satisfied the restore is correct.

## Retention of the archive

`message_content_archive` is not currently covered by the background GC jobs
in `services/deviceGc.ts` / `services/envelopeGc.ts` / `services/fileCleanup.ts`
— it is intentionally kept until a compliance/legal retention policy for
pre-E2EE history is decided separately. A future GC pass following the same
idempotent, env-configurable pattern as the existing jobs would be the
natural way to enforce that retention once a window is chosen.
