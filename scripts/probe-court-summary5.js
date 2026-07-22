#!/usr/bin/env node
/* Probe 5: execute the exact session query text from routes/court-summary.js
   against production, for Amber's June RR pairing, and report rows or error.
   Usage: railway run node scripts/probe-court-summary5.js */

'use strict';
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const PAIRING = '0ca25cb5-af63-4c15-8d23-95b042a2e229';
const GROUP = 'a9085fb6-67d2-4543-a9da-5eaaa891f0b5';
const MOM = 'fa77884f-342d-4069-9006-31b5a1a666ef';
const TRACK = '98831f87-690f-4b62-a7a0-ef8d95436d7e';

async function run() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'court-summary.js'), 'utf8');
  // Extract every template-literal SQL block that selects FROM "Session" s
  const blocks = [...src.matchAll(/pool\.query\(`([\s\S]*?)`,/g)]
    .map(m => m[1])
    .filter(q => q.includes('FROM "Session" s') && q.includes('SessionAttendance'));
  console.log('Found', blocks.length, 'session query blocks in route file.');

  for (let i = 0; i < blocks.length; i++) {
    console.log('\n=== QUERY BLOCK', i + 1, '===');
    try {
      const { rows } = await pool.query(blocks[i], [PAIRING, GROUP, MOM, TRACK]);
      console.log('rows:', rows.length);
      rows.forEach(r => console.log(' ', r.date ? new Date(r.date).toISOString().slice(0,10) : 'no-date',
        '|', r.momAttended || 'n/a', '|', r.noteStatus || 'no-note', '|', (r.sessionName || '').slice(0, 40)));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
