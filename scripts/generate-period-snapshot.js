#!/usr/bin/env node
/* ============================================================
   generate-period-snapshot.js
   Builds a point-in-time snapshot of mutable Trellis status
   fields as of a period's end date, using AuditLog reconstruction
   with a live-value fallback for records that were never audited.

   Usage (default = Q1 2026):
     node scripts/generate-period-snapshot.js

   Future quarters:
     PERIOD_KEY=2026-Q2 PERIOD_END=2026-06-30 \
       node scripts/generate-period-snapshot.js

   Safe to re-run after data corrections — uses ON CONFLICT DO UPDATE.
   ============================================================ */

const pool = require('../db');

const PERIOD_KEY = process.env.PERIOD_KEY || '2026-Q1';
const PERIOD_END = process.env.PERIOD_END || '2026-03-31';
const PERIOD_END_TS = `${PERIOD_END} 23:59:59`;

// ── Fields to snapshot ──────────────────────────────────────
// Each entry describes one (table, field) that needs a locked
// point-in-time value for quarterly reports.
const SNAPSHOT_FIELDS = [
  {
    recordType: 'Mom',
    fieldName: 'status',
    auditTable: 'Mom',
    liveTable: '"Mom"',
    liveField: '"status"',
    // Restrict to Moms that existed at period end
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'Mom intake-stage status (active, inactive, etc.) — used in momStatusCounts'
  },
  {
    recordType: 'Mom',
    fieldName: 'prospect_status',
    auditTable: 'Mom',
    liveTable: '"Mom"',
    liveField: '"prospect_status"',
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'Mom prospect/intake funnel status — used in referralSources, didNotEngageReasons'
  },
  {
    recordType: 'Mom',
    fieldName: 'referral_sub_status',
    auditTable: 'Mom',
    liveTable: '"Mom"',
    liveField: '"referral_sub_status"',
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'DNE reason breakdown — used in didNotEngageReasons grouping dimension'
  },
  {
    recordType: 'User',
    fieldName: 'advocate_status',
    auditTable: 'User',
    liveTable: '"User"',
    liveField: '"advocate_status"',
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'Advocate pipeline status — used in advocatePipeline'
  },
  {
    recordType: 'User',
    fieldName: 'advocate_sub_status',
    auditTable: 'User',
    liveTable: '"User"',
    liveField: '"advocate_sub_status"',
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'Advocate sub-status — used in advocateSubStatus'
  },
  {
    recordType: 'Child',
    fieldName: 'active_child_welfare_involvement',
    auditTable: 'Child',
    liveTable: '"Child"',
    liveField: '"active_child_welfare_involvement"',
    liveWhere: `m."deleted_at" = 0 AND m."created_at" <= '${PERIOD_END_TS}'`,
    liveAlias: 'm',
    note: 'CW involvement flag — used in childWelfareInvolvement'
  },
];

// ── Helpers ─────────────────────────────────────────────────

function fmt(n) {
  return n.toString().padStart(5);
}

function label(field) {
  return `${field.recordType}.${field.fieldName}`;
}

// ── Core reconstruction for one field ───────────────────────
// Returns { auditRows, fallbackRows, upserted }
async function snapshotField(client, field) {
  const { recordType, fieldName, auditTable, liveTable, liveField, liveWhere, liveAlias } = field;

  // ── Step 1: AuditLog reconstruction ──
  // Find the last recorded value for each record at or before period_end.
  // DISTINCT ON (id) + ORDER BY created_at DESC gives us the most recent entry.
  const auditSql = `
    SELECT DISTINCT ON (data->>'id')
      data->>'id'            AS record_id,
      data->>'${fieldName}'  AS field_value
    FROM "AuditLog"
    WHERE "table" = '${auditTable}'
      AND "action" = 'Update'
      AND data->>'${fieldName}' IS NOT NULL
      AND "created_at" <= '${PERIOD_END_TS}'
    ORDER BY data->>'id', "created_at" DESC
  `;

  const { rows: auditRows } = await client.query(auditSql);

  // ── Step 2: Live fallback ──
  // For records that existed before period_end but have NO AuditLog entry
  // for this field, their current live value = their value at creation
  // (it was never changed). Safe assumption: if a field never appeared in
  // the AuditLog before period_end, it hasn't changed since creation.
  const auditIds = auditRows.map(r => r.record_id);

  const fallbackSql = `
    SELECT ${liveAlias}."id"::text AS record_id,
           ${liveAlias}.${liveField}::text AS field_value
    FROM   ${liveTable} ${liveAlias}
    WHERE  ${liveWhere}
      ${auditIds.length > 0
        ? `AND ${liveAlias}."id"::text NOT IN (${auditIds.map((_, i) => `$${i + 1}`).join(', ')})`
        : '/* no audit rows — all records get live fallback */'
      }
  `;

  const { rows: fallbackRows } = await client.query(
    fallbackSql,
    auditIds.length > 0 ? auditIds : []
  );

  // ── Step 3: Upsert both sets into snapshot table ──
  const allRows = [
    ...auditRows.map(r => ({ ...r, source: 'audit_log' })),
    ...fallbackRows.map(r => ({ ...r, source: 'live_fallback' })),
  ];

  if (allRows.length === 0) {
    return { auditRows: 0, fallbackRows: 0, upserted: 0 };
  }

  // Build a multi-row VALUES clause
  const values = [];
  const params = [];
  let pi = 1;
  for (const row of allRows) {
    values.push(`($${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++})`);
    params.push(
      PERIOD_KEY,
      PERIOD_END,
      recordType,
      row.record_id,
      fieldName,
      row.field_value,   // may be null
      row.source
    );
  }

  const upsertSql = `
    INSERT INTO "ReportPeriodSnapshot"
      ("period_key", "period_end", "record_type", "record_id", "field_name", "field_value", "source")
    VALUES ${values.join(', ')}
    ON CONFLICT ("period_key", "record_type", "record_id", "field_name")
    DO UPDATE SET
      "field_value"    = EXCLUDED."field_value",
      "source"         = EXCLUDED."source",
      "snapshotted_at" = NOW()
  `;

  const result = await client.query(upsertSql, params);

  return {
    auditRows: auditRows.length,
    fallbackRows: fallbackRows.length,
    upserted: result.rowCount,
  };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  ReportPeriodSnapshot generator`);
  console.log(`  Period : ${PERIOD_KEY}  (cutoff: ${PERIOD_END})`);
  console.log('══════════════════════════════════════════════════════');

  // ── Probe: show AuditLog coverage before writing ──
  console.log('\n── AuditLog coverage probe ──');
  const { rows: coverage } = await pool.query(`
    SELECT
      "table",
      jsonb_object_keys(data) AS field_name,
      COUNT(*)::int AS change_count
    FROM "AuditLog"
    WHERE "table" IN ('Mom', 'User', 'Child')
      AND "created_at" <= '${PERIOD_END_TS}'
    GROUP BY "table", field_name
    ORDER BY "table", change_count DESC
  `);

  const fieldSet = new Set(
    SNAPSHOT_FIELDS.map(f => `${f.auditTable}:${f.fieldName}`)
  );
  console.log('');
  console.log('  table    field_name                            change_count  in-scope?');
  console.log('  -------- ------------------------------------- ------------ ----------');
  for (const row of coverage) {
    const key = `${row.table}:${row.field_name}`;
    const flag = fieldSet.has(key) ? '  ← SNAPSHOT' : '';
    const inScope = fieldSet.has(key) ? 'YES' : '';
    console.log(
      `  ${row.table.padEnd(8)} ${row.field_name.padEnd(45)} ${String(row.change_count).padStart(8)}   ${inScope}${flag}`
    );
  }

  // ── Per-field snapshot ──
  console.log('\n── Generating snapshots ──\n');
  const client = await pool.connect();

  const summary = [];
  try {
    for (const field of SNAPSHOT_FIELDS) {
      process.stdout.write(`  ${label(field).padEnd(42)} ...`);
      const t0 = Date.now();

      const stats = await snapshotField(client, field);
      const ms = Date.now() - t0;

      const line = `  audit=${fmt(stats.auditRows)}  fallback=${fmt(stats.fallbackRows)}  upserted=${fmt(stats.upserted)}  (${ms}ms)`;
      console.log(` ✓  ${line}`);
      summary.push({ field: label(field), ...stats, note: field.note });
    }
  } finally {
    client.release();
  }

  // ── Summary ──
  console.log('');
  console.log('── Summary ─────────────────────────────────────────');
  for (const s of summary) {
    console.log(`  ${s.field.padEnd(42)}  audit=${fmt(s.auditRows)}  fallback=${fmt(s.fallbackRows)}`);
    console.log(`  ${''.padEnd(42)}  ${s.note}`);
  }

  const totalUpserted = summary.reduce((acc, s) => acc + s.upserted, 0);
  console.log('');
  console.log(`  Total rows written: ${totalUpserted}`);
  console.log('');
  console.log('  ✓ Snapshot complete. Q1 Category C fields are now locked.');
  console.log('    Re-run this script after any data correction to refresh.');
  console.log('══════════════════════════════════════════════════════');
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('\n✗ Snapshot generation failed:');
  console.error(err.message);
  process.exit(1);
});
