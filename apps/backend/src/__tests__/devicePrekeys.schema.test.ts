/**
 * Schema-level guarantees for `device_prekeys` (issue #104).
 *
 * The three invariants this table exists to enforce live in the DDL, not in
 * route code, so they are asserted against the Drizzle table definition (and
 * the generated migration that actually reaches Postgres) rather than through
 * a request:
 *
 *   1. one active signed prekey per device, many one-time prekeys
 *   2. a one-time prekey is consumed at most once (`consumed` flips, no delete)
 *   3. `key_type = 'signed'` rows must carry a signature
 *
 * Assertion (2)'s atomicity is exercised in users.bundle.test.ts — here we only
 * pin the column + partial index the claim query depends on.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { devicePrekeys, prekeyTypeEnum } from '../db/schema.js';

const cfg = getTableConfig(devicePrekeys);
const dialect = new PgDialect();

function column(name: string) {
  return cfg.columns.find((c) => c.name === name);
}

function index(name: string) {
  return cfg.indexes.find((i) => i.config.name === name);
}

/** Serialized predicate of a partial index, e.g. `"…"."key_type" = 'signed'`. */
function indexPredicate(name: string) {
  const where = index(name)?.config.where;
  return where ? dialect.sqlToQuery(where).sql : undefined;
}

describe('device_prekeys table shape', () => {
  it('is named device_prekeys', () => {
    expect(cfg.name).toBe('device_prekeys');
  });

  it('has a uuid primary key', () => {
    const id = column('id');
    expect(id?.getSQLType()).toBe('uuid');
    expect(id?.primary).toBe(true);
    expect(id?.hasDefault).toBe(true);
  });

  it('declares every prekey column with the right type and nullability', () => {
    expect(column('device_id')?.getSQLType()).toBe('uuid');
    expect(column('device_id')?.notNull).toBe(true);

    expect(column('key_type')?.getSQLType()).toBe('prekey_type');
    expect(column('key_type')?.notNull).toBe(true);

    expect(column('key_id')?.getSQLType()).toBe('integer');
    expect(column('key_id')?.notNull).toBe(true);

    expect(column('public_key')?.getSQLType()).toBe('text');
    expect(column('public_key')?.notNull).toBe(true);

    expect(column('created_at')?.notNull).toBe(true);
    expect(column('created_at')?.hasDefault).toBe(true);
  });

  it('leaves signature nullable — only signed prekeys carry one', () => {
    expect(column('signature')?.getSQLType()).toBe('text');
    expect(column('signature')?.notNull).toBe(false);
  });

  it('defaults consumed to false', () => {
    expect(column('consumed')?.getSQLType()).toBe('boolean');
    expect(column('consumed')?.notNull).toBe(true);
    expect(column('consumed')?.hasDefault).toBe(true);
    expect(column('consumed')?.default).toBe(false);
  });

  it('discriminates key types via the prekey_type enum', () => {
    expect(prekeyTypeEnum.enumName).toBe('prekey_type');
    expect(prekeyTypeEnum.enumValues).toEqual(['signed', 'one_time']);
  });

  it('cascades from devices so revoked-and-deleted devices drop their prekeys', () => {
    expect(cfg.foreignKeys).toHaveLength(1);

    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();

    expect(ref.columns.map((c) => c.name)).toEqual(['device_id']);
    expect(getTableConfig(ref.foreignTable).name).toBe('devices');
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('device_prekeys invariants', () => {
  it('rejects a duplicate keyId within a device + key type', () => {
    const idx = index('device_prekeys_device_type_keyid_idx');

    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'device_id',
      'key_type',
      'key_id',
    ]);
    // Unconditional: uniqueness must hold for consumed rows too, so a
    // consumed one-time prekey's id can never be re-registered.
    expect(idx?.config.where).toBeUndefined();
  });

  it('allows exactly one signed prekey per device', () => {
    const idx = index('device_prekeys_signed_device_idx');

    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['device_id']);
    expect(indexPredicate('device_prekeys_signed_device_idx')).toBe(
      `"device_prekeys"."key_type" = 'signed'`,
    );
  });

  it('allows many one-time prekeys per device', () => {
    // The only per-device uniqueness constraints are the signed-prekey one
    // above and the (device, type, keyId) triple — nothing caps how many
    // one_time rows a single device may hold.
    const perDeviceUnique = cfg.indexes.filter(
      (i) =>
        i.config.unique &&
        i.config.columns.length === 1 &&
        (i.config.columns[0] as { name: string }).name === 'device_id',
    );

    expect(perDeviceUnique.map((i) => i.config.name)).toEqual(['device_prekeys_signed_device_idx']);
  });

  it('indexes unconsumed one-time prekeys for claim lookups', () => {
    const idx = index('device_prekeys_one_time_available_idx');

    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['device_id']);
    expect(indexPredicate('device_prekeys_one_time_available_idx')).toBe(
      `"device_prekeys"."key_type" = 'one_time' AND "device_prekeys"."consumed" = false`,
    );
  });

  it('requires a signature on signed prekey rows', () => {
    const constraint = cfg.checks.find(
      (c) => c.name === 'device_prekeys_signed_requires_signature',
    );

    expect(constraint).toBeDefined();
    expect(dialect.sqlToQuery(constraint!.value).sql).toBe(
      `"device_prekeys"."key_type" <> 'signed' OR "device_prekeys"."signature" IS NOT NULL`,
    );
  });
});

describe('device_prekeys migrations', () => {
  // The invariants above are only real if they were generated into a migration.
  // Guards against editing schema.ts without re-running `pnpm db:generate`.
  const migrationDir = join(import.meta.dirname, '../../drizzle');
  const ddl = readdirSync(migrationDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationDir, f), 'utf8'))
    .join('\n');

  it('creates the table and its enum', () => {
    expect(ddl).toContain('CREATE TABLE "device_prekeys"');
    expect(ddl).toContain(`CREATE TYPE "public"."prekey_type" AS ENUM('signed', 'one_time')`);
  });

  it('cascades the device_id foreign key', () => {
    expect(ddl).toMatch(
      /ALTER TABLE "device_prekeys" ADD CONSTRAINT "device_prekeys_device_id_devices_id_fk"[\s\S]*?REFERENCES "public"\."devices"\("id"\) ON DELETE cascade/,
    );
  });

  it('emits both partial indexes and the signature check', () => {
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX "device_prekeys_device_type_keyid_idx" ON "device_prekeys" USING btree ("device_id","key_type","key_id")',
    );
    expect(ddl).toContain(
      `CREATE UNIQUE INDEX "device_prekeys_signed_device_idx" ON "device_prekeys" USING btree ("device_id") WHERE "device_prekeys"."key_type" = 'signed'`,
    );
    expect(ddl).toContain(
      `CREATE INDEX "device_prekeys_one_time_available_idx" ON "device_prekeys" USING btree ("device_id") WHERE "device_prekeys"."key_type" = 'one_time' AND "device_prekeys"."consumed" = false`,
    );
    expect(ddl).toContain(
      `CONSTRAINT "device_prekeys_signed_requires_signature" CHECK ("device_prekeys"."key_type" <> 'signed' OR "device_prekeys"."signature" IS NOT NULL)`,
    );
  });
});
