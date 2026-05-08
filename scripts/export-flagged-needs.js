#!/usr/bin/env node
/* ============================================================
   Flagged Needs Export — Q1 2026
   BenevolenceNeed table: Q1 window, Trellis-native rows only.

   Usage (from repo root):
     railway run node scripts/export-flagged-needs.js

   Writes three CSVs to the repo root:
     flagged-needs-overall.csv
     flagged-needs-by-type.csv
     flagged-needs-by-affiliate.csv
   ============================================================ */

const fs   = require('fs');
const path = require('path');
const pool = require('../db');

const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-04-01';  // exclusive upper bound

// ─── CSV helpers ────────────────────────────────────────────
function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(k => csvEsc(r[k])).join(','));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`  Wrote ${rows.length} row(s) → ${filePath}`);
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log('Flagged Needs Export — Q1 2026\n');

  // 0. Probe BenevolenceNeed schema to confirm column names
  const schemaRes = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'BenevolenceNeed'
    ORDER BY ordinal_position
  `);
  if (schemaRes.rows.length === 0) {
    console.error('BenevolenceNeed table not found or no columns returned. Aborting.');
    process.exit(1);
  }
  const cols = schemaRes.rows.map(r => r.column_name);
  console.log(`BenevolenceNeed columns (${cols.length}): ${cols.join(', ')}\n`);

  // Verify expected columns exist
  const required = ['created_at', 'deleted_at', 'legacy_ps_id', 'did_address_need_c', 'type_c', 'momId'];
  const missing = required.filter(c => !cols.includes(c));
  if (missing.length > 0) {
    console.error(`Missing expected columns: ${missing.join(', ')}`);
    console.error('Check actual column names above and update this script.');
    process.exit(1);
  }

  // Check deleted_at type — numeric 0 vs string '0'
  const deletedAtType = schemaRes.rows.find(r => r.column_name === 'deleted_at')?.data_type || '';
  // Use ::text = '0' cast which works for both integer 0 and varchar '0'
  console.log(`deleted_at data_type: ${deletedAtType}`);

  // ─── Shared WHERE fragment ───────────────────────────────
  // Trellis-native rows in Q1 window, not soft-deleted
  const baseWhere = `
    WHERE bn."created_at" >= '${PERIOD_START}'
      AND bn."created_at" <  '${PERIOD_END}'
      AND bn."deleted_at"::text = '0'
      AND bn."legacy_ps_id" IS NULL
  `;

  // ─── Query 1: Overall ────────────────────────────────────
  const overallQ = `
    SELECT
      COUNT(*)::int                                                                   AS total_flagged,
      SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)::int           AS total_met,
      ROUND(
        100.0 * SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0)
      )::int || '%'                                                                   AS pct_met
    FROM "BenevolenceNeed" bn
    ${baseWhere}
  `;

  // ─── Query 2: By type ────────────────────────────────────
  const byTypeQ = `
    SELECT
      bn."type_c"                                                                     AS type_c,
      COUNT(*)::int                                                                   AS total_flagged,
      SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)::int           AS total_met,
      ROUND(
        100.0 * SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0)
      )::int || '%'                                                                   AS pct_met
    FROM "BenevolenceNeed" bn
    ${baseWhere}
    GROUP BY bn."type_c"
    ORDER BY total_flagged DESC
  `;

  // ─── Query 3: By affiliate ───────────────────────────────
  const byAffiliateQ = `
    SELECT
      COALESCE(a."name", '(no affiliate)')                                            AS affiliate_name,
      COUNT(*)::int                                                                   AS total_flagged,
      SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)::int           AS total_met,
      ROUND(
        100.0 * SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0)
      )::int || '%'                                                                   AS pct_met,
      CASE WHEN COUNT(*) < 5 THEN 'small sample — interpret with caution' ELSE '' END AS note
    FROM "BenevolenceNeed" bn
    JOIN "Mom" m ON m."id" = bn."momId"
    LEFT JOIN "Affiliate" a ON a."id" = m."affiliate_id"
    ${baseWhere}
    GROUP BY a."name"
    ORDER BY total_flagged DESC
  `;

  // ─── Run all three in parallel ───────────────────────────
  console.log('Running queries...');
  const [overallRes, byTypeRes, byAffRes] = await Promise.all([
    pool.query(overallQ),
    pool.query(byTypeQ),
    pool.query(byAffiliateQ),
  ]);

  // ─── Print to console ────────────────────────────────────
  console.log('\n=== OVERALL ===');
  console.table(overallRes.rows);

  console.log('\n=== BY TYPE ===');
  console.table(byTypeRes.rows);

  console.log('\n=== BY AFFILIATE ===');
  console.table(byAffRes.rows);

  // ─── Write CSVs ──────────────────────────────────────────
  const outDir = process.cwd();
  console.log('\nWriting CSVs...');
  writeCsv(
    path.join(outDir, 'flagged-needs-overall.csv'),
    ['total_flagged', 'total_met', 'pct_met'],
    overallRes.rows
  );
  writeCsv(
    path.join(outDir, 'flagged-needs-by-type.csv'),
    ['type_c', 'total_flagged', 'total_met', 'pct_met'],
    byTypeRes.rows
  );
  writeCsv(
    path.join(outDir, 'flagged-needs-by-affiliate.csv'),
    ['affiliate_name', 'total_flagged', 'total_met', 'pct_met', 'note'],
    byAffRes.rows
  );

  console.log('\nDone.');
  await pool.end();
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
