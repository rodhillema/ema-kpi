#!/usr/bin/env node
/* Probe 4: pairing status sub-status fields for Amber's pairings.
   Usage: railway run node scripts/probe-court-summary4.js */

'use strict';
const pool = require('../db');

async function run() {
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Pairing'
      AND (column_name ILIKE '%status%' OR column_name ILIKE '%reason%'
           OR column_name ILIKE '%complete%' OR column_name ILIKE '%discharge%')
    ORDER BY ordinal_position
  `);
  console.log('=== Pairing status-ish COLUMNS ===');
  cols.rows.forEach(r => console.log(' ', r.column_name, '(' + r.data_type + ')'));

  const colNames = cols.rows.map(r => `p."${r.column_name}"::text AS "${r.column_name}"`).join(', ');
  const vals = await pool.query(`
    SELECT p."id", t."title" AS track, p."created_at", ${colNames}
    FROM "Pairing" p
    JOIN "Mom" m ON m."id" = p."momId"
    LEFT JOIN "Track" t ON t."id" = p."trackId"
    WHERE m."first_name" = 'Amber' AND m."last_name" = 'Fernandez'
      AND p."deleted_at" = 0
    ORDER BY p."created_at"
  `);
  console.log('\n=== AMBER PAIRING STATUS VALUES ===');
  console.log(JSON.stringify(vals.rows, null, 2));

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
