#!/usr/bin/env node
/* Probe 6: SessionAttendance + SessionNote columns.
   Usage: railway run node scripts/probe-court-summary6.js */

'use strict';
const pool = require('../db');

async function run() {
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('SessionAttendance', 'SessionNote')
    ORDER BY table_name, ordinal_position
  `);
  let cur = '';
  cols.rows.forEach(r => {
    if (r.table_name !== cur) { cur = r.table_name; console.log('\n-- ' + cur); }
    console.log('  ', r.column_name, '(' + r.data_type + ')');
  });

  // Sample attendance rows for Amber to see actual values
  const sample = await pool.query(`
    SELECT * FROM "SessionAttendance"
    WHERE "mom_id" = 'fa77884f-342d-4069-9006-31b5a1a666ef' AND "deleted_at" = 0
    LIMIT 3
  `);
  console.log('\n=== SAMPLE ATTENDANCE ROWS ===');
  console.log(JSON.stringify(sample.rows, null, 2));

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
