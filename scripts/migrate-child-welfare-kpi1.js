#!/usr/bin/env node
/**
 * migrate-child-welfare-kpi1.js
 *
 * One-time data migration for Q2 2026 KPI 1.
 *
 * Reads a child welfare CSV (two columns per child: intake_welfare_status
 * and latest_welfare_status) and writes family_preservation_goal and
 * family_preservation_impact onto each Child record.
 *
 * Background: Trellis overwrote child welfare status with no history.
 * A historical cleanup captured the two-point trajectory (intake → latest).
 * This migration writes those derived values so the standard KPI 1 query
 * runs unchanged.
 *
 * Usage:
 *   node scripts/migrate-child-welfare-kpi1.js --csv path/to/file.csv [--dry-run]
 *
 * --dry-run   Print what would be updated without touching the database.
 * --csv       Path to the CSV file from RD's Supabase export.
 *
 * Required env: DATABASE_URL
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvIndex = args.indexOf('--csv');
const csvPath = csvIndex !== -1 ? args[csvIndex + 1] : null;
const dryRun = args.includes('--dry-run');

if (!csvPath) {
  console.error('Usage: node scripts/migrate-child-welfare-kpi1.js --csv <path> [--dry-run]');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Goal mapping ─────────────────────────────────────────────────────────────
// intake_welfare_status → Child.family_preservation_goal
function mapGoal(intake) {
  const s = (intake || '').trim().toLowerCase();
  if (s === 'custody maintained' || s === 'supportive services') {
    return 'prevent_cps_involvement';
  }
  if (s === 'differential response' || s === 'open investigation' || s === 'protective services') {
    return 'prevent_foster_care_placement';
  }
  if (s === 'kinship placement') {
    return 'prevent_permanent_removal';
  }
  if (s === 'permanently removed') {
    return 'not_eligible_program';
  }
  return null; // unknown / blank — will be skipped
}

// ── Impact mapping ────────────────────────────────────────────────────────────
// (goal, latest_welfare_status) → Child.family_preservation_impact
function mapImpact(goal, latest) {
  const l = (latest || '').trim().toLowerCase();

  if (goal === 'prevent_cps_involvement' && l === 'custody maintained') {
    return 'prevented_from_cps_involvement';
  }
  if (goal === 'prevent_foster_care_placement' && l === 'custody maintained') {
    return 'prevented_from_foster_care_placement';
  }
  if (goal === 'prevent_permanent_removal' && l !== 'permanently removed') {
    return 'prevented_from_permanent_removal';
  }
  if (
    (goal === 'prevent_cps_involvement' || goal === 'prevent_foster_care_placement') &&
    (l === 'foster care placement' || l === 'kinship placement')
  ) {
    return 'temporary_removal';
  }
  if (l === 'permanently removed') {
    return 'permanent_removal';
  }
  return null; // unresolved — leave NULL
}

// ── CSV parser (no external deps) ────────────────────────────────────────────
function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());

  function col(row, name) {
    const i = headers.indexOf(name);
    if (i === -1) return '';
    return (row[i] || '').replace(/^"|"$/g, '').trim();
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Basic CSV split — handles quoted fields containing commas
    const parts = [];
    let current = '';
    let inQuote = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { parts.push(current); current = ''; }
      else { current += ch; }
    }
    parts.push(current);

    rows.push({
      child_id:             col(parts, 'child_id'),
      intake_welfare_status: col(parts, 'intake_welfare_status'),
      latest_welfare_status: col(parts, 'latest_welfare_status'),
    });
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[migrate-child-welfare-kpi1] ${dryRun ? 'DRY RUN — ' : ''}Starting`);
  console.log(`CSV: ${path.resolve(csvPath)}\n`);

  // Pre-migration count
  const { rows: nullCount } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM "Child"
     WHERE "deleted_at" = 0 AND "family_preservation_goal" IS NULL`
  );
  console.log(`Children currently NULL for family_preservation_goal: ${nullCount[0].count}`);

  const rows = parseCSV(csvPath);
  console.log(`CSV rows loaded: ${rows.length}\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const skippedReasons = {};

  for (const row of rows) {
    if (!row.child_id) { skipped++; continue; }

    const goal = mapGoal(row.intake_welfare_status);
    if (!goal) {
      const reason = `unknown intake: "${row.intake_welfare_status}"`;
      skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
      skipped++;
      continue;
    }

    const impact = mapImpact(goal, row.latest_welfare_status);

    if (dryRun) {
      console.log(`  [dry] child ${row.child_id}: goal=${goal} impact=${impact ?? 'NULL'}`);
      updated++;
      continue;
    }

    try {
      const result = await pool.query(
        `UPDATE "Child"
         SET "family_preservation_goal" = $1,
             "family_preservation_impact" = $2
         WHERE "id" = $3 AND "deleted_at" = 0`,
        [goal, impact, row.child_id]
      );
      if (result.rowCount === 0) {
        const reason = `child_id not found or deleted`;
        skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
        skipped++;
      } else {
        updated++;
      }
    } catch (err) {
      console.error(`  [error] child ${row.child_id}: ${err.message}`);
      errors++;
    }
  }

  // Post-migration count
  if (!dryRun) {
    const { rows: afterCount } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "Child"
       WHERE "deleted_at" = 0 AND "family_preservation_goal" IS NULL`
    );
    console.log(`\nChildren still NULL for family_preservation_goal after migration: ${afterCount[0].count}`);
  }

  console.log(`\n── Summary ──`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);
  if (Object.keys(skippedReasons).length) {
    console.log(`  Skip reasons:`);
    for (const [reason, count] of Object.entries(skippedReasons)) {
      console.log(`    ${reason}: ${count}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
