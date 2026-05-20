# Permanent Fix: ChampionUser / ChampionAccess Prisma Migration

## Background

On May 20, 2026, Trellis production login broke after a Railway outage triggered
a restart. Root cause: the Trellis Prisma schema included `ChampionUser` and
`ChampionAccess` tables that had never been formally migrated. The `diff:prisma`
deploy step detects schema drift and exits with code 2, blocking `ema-api` from
starting.

An emergency baseline workaround was applied to restore login. This document
describes the permanent fix needed.

---

## What Was Done as a Workaround (May 20, 2026)

1. Created a placeholder migration file in the Trellis repo:
   `packages/dataschema/prisma/migrations/20260424000000_add_champion_tables/migration.sql`
   Content is just `SELECT 1;` — it does not actually create anything.

2. Manually inserted a row into `_prisma_migrations` to tell Prisma the migration
   is already applied:
   ```sql
   INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, ...)
   VALUES (gen_random_uuid()::text, 'baseline', now(), '20260424000000_add_champion_tables', ...)
   ```

3. Manually created the missing indexes and `ChampionAccess` table directly in
   the production DB via the Railway query editor.

This unblocked the deploy but is not a proper Prisma migration — a fresh
environment would not get the correct schema automatically.

---

## What Is Needed for the Permanent Fix

### Step 1 — Get the exact production schema

Run this in the Railway query editor against `ema-postgres` (production):

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN ('ChampionUser', 'ChampionAccess')
ORDER BY table_name, ordinal_position;
```

Paste the results to RD — he will write the exact `CREATE TABLE` SQL.

### Step 2 — Replace the placeholder migration file

In the Trellis repo (`ema1_admin/trellis-ema`), replace the content of:
```
packages/dataschema/prisma/migrations/20260424000000_add_champion_tables/migration.sql
```

Replace `SELECT 1;` with the real `CREATE TABLE` statements for both tables,
including all columns, primary keys, foreign keys, and unique indexes.

### Step 3 — Update the checksum in production

Because the migration file content is changing, Prisma's stored checksum needs
to be updated. Run in Railway query editor:

```sql
UPDATE "_prisma_migrations"
SET checksum = 'baseline-updated'
WHERE migration_name = '20260424000000_add_champion_tables';
```

### Step 4 — Verify on training environment

Before deploying to production, confirm the training environment deploys cleanly
with the updated migration file.

### Step 5 — Redeploy ema-prisma-migrate in production

Trigger a redeploy of `ema-prisma-migrate` in Railway production. The
`diff:prisma` step should pass with no drift detected.

---

## Why This Matters

Without the permanent fix:
- Any fresh Railway environment (new deploy, staging, disaster recovery) will
  NOT have `ChampionUser` or `ChampionAccess` and Trellis will fail to start
- The placeholder migration file gives Prisma a false sense of correctness
- Future schema changes that depend on these tables may fail

---

## Repo Reference

- Trellis repo: `ema1_admin/trellis-ema` (GitHub Enterprise)
- Migration path: `packages/dataschema/prisma/migrations/`
- Last real migration before our workaround: `20260420000000_seed_notification_config`
- Workaround migration: `20260424000000_add_champion_tables`
