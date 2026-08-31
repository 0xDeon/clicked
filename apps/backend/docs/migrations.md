# Database migration workflow

How schema changes reach a database in this repository. Everything here is `drizzle-kit`
driven and lives under `apps/backend`; run every command from that directory (or with
`pnpm --filter backend`).

---

## The one-sentence version

Edit `src/db/schema.ts`, run `pnpm db:generate`, **read the SQL it emitted**, commit both
the schema change and the generated files together, and apply it with `pnpm db:migrate`.

---

## `schema.ts` is the source of truth

`src/db/schema.ts` is the single declarative description of the database. The files in
`drizzle/` are _output_: drizzle-kit diffs the schema against the snapshot of the last
generated state and writes the SQL needed to close the gap.

**Never hand-write a migration first and then update the schema to match.** Doing it in that
order means the next `pnpm db:generate` diffs against a snapshot that does not reflect what
your SQL did, and it emits a second migration trying to re-apply — or worse, to undo — the
same change. The snapshot, not the database, is what drizzle-kit compares against, so it has
no way to notice that your SQL already handled it.

There is one legitimate exception: a change drizzle-kit cannot express (a data backfill, a
`CREATE INDEX CONCURRENTLY`, a multi-step column rewrite). Handle it by generating the
migration normally first, then editing the emitted `.sql` file to add the extra statements —
so the journal entry and the snapshot still describe the change. Keep the edits inside the
generated file; do not add a `.sql` file that drizzle-kit did not create.

Config lives in `drizzle.config.ts`: schema `./src/db/schema.ts`, output `./drizzle`,
dialect `postgresql`, and `DATABASE_URL` for credentials.

---

## The workflow

### 1. Edit the schema

```ts
// src/db/schema.ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').unique(),
  // ... new column here
});
```

### 2. Generate

```bash
pnpm --filter backend db:generate
```

This writes three things:

- `drizzle/NNNN_<random_name>.sql` — the DDL,
- `drizzle/meta/NNNN_snapshot.json` — the full schema state after this migration,
- a new entry appended to `drizzle/meta/_journal.json`.

The `<random_name>` suffix is generated (`0000_lean_scrambler`). You may rename the file to
something descriptive, but if you do you **must** update the matching `tag` in
`_journal.json` — the tag is how the runner finds the file.

### 3. Review the emitted SQL

This is the step people skip, and it is the one that matters. drizzle-kit infers intent from
a diff, and a diff is ambiguous in ways that lose data:

- **A rename looks like a drop plus an add.** If you renamed a column, drizzle-kit will
  usually prompt; if it guesses wrong you get `DROP COLUMN` followed by `ADD COLUMN`, and
  every existing value is gone. Rewrite it as `ALTER TABLE ... RENAME COLUMN ...`.
- **A new `NOT NULL` column with no default fails on a non-empty table.** Add a default, or
  split it into add-nullable, backfill, then set `NOT NULL`.
- **A type change may need a `USING` clause** that drizzle-kit will not write for you.
- **Dropping a column is silent and irreversible.** Confirm every `DROP` in the diff is one
  you meant.

If the SQL is wrong, fix the schema and regenerate rather than patching the SQL — unless it
is the "cannot be expressed" case above.

### 4. Apply

```bash
pnpm --filter backend db:migrate
```

`db:migrate` walks `_journal.json` in order and runs each migration that the target database
has not recorded yet, inside a transaction, tracking applied migrations in drizzle's own
bookkeeping table. It is the only command that should ever touch a shared database.

`pnpm db:push` also exists. It diffs the schema straight onto a database with **no**
migration file and no journal entry, which puts that database into a state no migration
history describes. Use it for throwaway local experiments only, never against a shared or
production database, and never as a substitute for generating a migration.

### 5. Commit together

The schema change, the `.sql` file, the new snapshot, and the `_journal.json` change belong
in one commit. Splitting them produces a revision where the schema and the migration history
disagree.

---

## The `drizzle/` directory

```
apps/backend/drizzle/
├── 0000_lean_scrambler.sql      # DDL for migration 0
├── meta/
│   ├── _journal.json            # ordered list of migrations to run
│   └── 0000_snapshot.json       # full schema state after migration 0
```

**`.sql` files** are the migrations themselves, prefixed with a zero-padded index in apply
order. Statements are separated by drizzle's `--> statement-breakpoint` marker, which is what
`breakpoints: true` in the journal refers to; it tells the runner where one statement ends so
it can run them individually.

**`meta/_journal.json`** is the index. Each entry carries `idx` (apply order), `version`,
`when` (generation timestamp), `tag` (the `.sql` filename without its extension), and
`breakpoints`.

> **The journal decides what runs.** `db:migrate` reads `_journal.json`, not the directory
> listing. A `.sql` file sitting in `drizzle/` with no entry in the journal is **silently
> skipped** — no error, no warning, and the migration simply never happens. Because
> drizzle-kit rewrites the journal on every generate, this is exactly what a mishandled merge
> produces, and the failure surfaces much later as a "column does not exist" error in an
> environment where nobody remembers what changed.

**`meta/NNNN_snapshot.json`** is the complete schema state after that migration. drizzle-kit
diffs the current `schema.ts` against the latest snapshot to work out what the next migration
should contain. A stale, missing, or hand-edited snapshot makes the _next_ contributor's
generate wrong, not yours — which is why snapshot conflicts must never be resolved by
guessing.

`drizzle/meta/` is listed in `.prettierignore`. It is generated output, not hand-edited
source: reformatting it produces enormous noisy diffs, and drizzle-kit rewrites it in its own
format on the next generate anyway. Do not run Prettier over it, and do not "tidy" it by
hand.

---

## The merge hazard

This is the one thing to internalise, because **it has already broken this repository's
migration history once.**

drizzle-kit numbers migrations by "one past the highest index I currently see" and appends to
the journal. It has no knowledge of other branches. So when two branches each add a
migration off the same base:

- Branch A generates `0001_audit_logs.sql` and appends journal entry `idx: 1`.
- Branch B generates `0001_mls_key_packages.sql` and appends journal entry `idx: 1`.

Both are correct in isolation. Merged, the result is two different migrations claiming index
`0001`, two snapshots claiming to be `0001_snapshot.json`, and two journal entries claiming
`idx: 1`. Git resolves the `.sql` files trivially — they have different names, so both are
simply kept — while the real damage happens inside `_journal.json`, where a careless
conflict resolution merges the two entries into one malformed object.

That is precisely what happened here. Before commit `d60b648`, `drizzle/` held **seven**
distinct `0001_*.sql` files (`audit_logs`, `device_key_history`, `gc_background_jobs`,
`group_control_events`, `mls_group_state`, `mls_key_packages`,
`add_system_payload_to_messages`) — and a journal whose entry for `idx: 1` looked like this:

```json
{
  "idx": 1,
  "version": "7",
  "when": 1785395646991,
  "tag": "0001_mls_group_state",
  "when": 1785395076224,
  "tag": "0001_mls_key_packages",
  "when": 1785129818340,
  "tag": "0001_add_system_payload_to_messages",
  "breakpoints": true
}
```

Duplicate keys in a JSON object are not an error — the last one wins. So that entry ran
`0001_add_system_payload_to_messages` and nothing else. Across the whole directory, thirteen
`.sql` files were present and four journal entries existed: **nine migrations were silently
skipped**, and the journal even referenced `0004_envelope_protocol` at `idx: 3` while
`0003_ciphertext_only_messages.sql` was never listed at all. The history was unrecoverable
and had to be squashed back to a single `0000_lean_scrambler.sql` baseline.

Nothing warns you about this. `pnpm db:migrate` reports success, because from the runner's
point of view it did exactly what the journal asked.

### Resolving a migration conflict during a merge

When a merge touches `drizzle/`, do **not** hand-resolve `_journal.json` or the snapshots.
Regenerate instead:

1. **Merge everything else first.** Resolve `src/db/schema.ts` on its own terms — both
   branches' table and column definitions must survive, and this is the only file where a
   real semantic decision is needed.
2. **Take the other branch's `drizzle/` wholesale** — the branch you are merging _into_,
   normally `dev`:

   ```bash
   git checkout --theirs apps/backend/drizzle    # during a merge into your branch
   git checkout dev -- apps/backend/drizzle      # or, explicitly, from the base branch
   ```

3. **Delete your own branch's migration files** — the `.sql` and its `meta/NNNN_snapshot.json`
   — and make sure they are gone from `_journal.json`. Your change now exists only in
   `schema.ts`, which is where it belongs.
4. **Regenerate:**

   ```bash
   pnpm --filter backend db:generate
   ```

   drizzle-kit diffs your merged `schema.ts` against the base branch's latest snapshot and
   emits a single migration at the correct next index, with a clean journal entry.

5. **Review the new SQL.** It should contain your change and nothing from the other branch —
   if it tries to re-create something the other branch's migration already made, the
   snapshot you kept in step 2 was the wrong one.
6. **Verify before pushing**, against a scratch database:

   ```bash
   pnpm --filter backend db:migrate
   ```

Checks that catch the problem before it lands:

- The number of `.sql` files in `drizzle/` equals the number of entries in `_journal.json`.
- Every `tag` in the journal names a file that exists, and every file is named by a tag.
- `idx` values are unique and contiguous from `0`.
- No index prefix appears on two files.
- `_journal.json` contains no duplicate keys within an entry.

If you have already pushed a colliding migration, fix it by regenerating on a follow-up
commit as above. Do not renumber files by hand — the snapshots encode the chain, and renaming
a file without rebuilding its snapshot corrupts the next generate.

---

## Rolling back

There is no `db:rollback`. drizzle-kit generates forward migrations only. To undo an applied
change, generate a new forward migration that reverses it — which means destructive
migrations deserve extra review, since "revert the PR" does not revert the database.

Where a destructive change has needed a documented undo path, this repository has used a
`drizzle/rollback/` directory holding `NNNN_<name>.down.sql` files. Those are operator-run:
they are never listed in `_journal.json` and `db:migrate` never executes them. The directory
is absent whenever no migration currently needs one; recreate it if yours does.

---

## Migrations and the test suite

Backend tests never run migrations and never connect to Postgres — the database client is
mocked. See [Testing strategy and conventions](../../../docs/testing.md). Migrations are
validated in CI instead: the backend workflow starts a real Postgres service container and
runs `pnpm db:migrate` against it before the test step, so a migration that does not apply
cleanly to an empty database fails the build.

That check is only as good as the journal, though. A migration missing from `_journal.json`
is skipped in CI exactly as silently as it is skipped everywhere else, so the review checks
above are not optional.
