#!/usr/bin/env node
/* Probe 3: verify pairing-scoped session query for both of Amber's RR pairings.
   Usage: railway run node scripts/probe-court-summary3.js */

'use strict';
const pool = require('../db');

const MOM_ID = 'fa77884f-342d-4069-9006-31b5a1a666ef';
const TRACK_RR = '98831f87-690f-4b62-a7a0-ef8d95436d7e';
const PAIRINGS = [
  { label: 'MARCH RR (7b04c5b6, group f1479f86)', id: '7b04c5b6-afcb-40f7-bc8b-ce3c687286b2', gid: 'f1479f86-dd11-4590-9cf8-7bbbd4b27b0b' },
  { label: 'JUNE RR (0ca25cb5, group a9085fb6)',  id: '0ca25cb5-af63-4c15-8d23-95b042a2e229', gid: 'a9085fb6-67d2-4543-a9da-5eaaa891f0b5' },
];

async function run() {
  for (const p of PAIRINGS) {
    const { rows } = await pool.query(`
      SELECT s."id", s."name", s."date_start", sa."status"::text AS attended
      FROM "Session" s
      LEFT JOIN "SessionAttendance" sa
        ON sa."session_id" = s."id" AND sa."mom_id" = $3 AND sa."deleted_at" = 0
      WHERE s."deleted_at" = 0
        AND (
          s."pairing_id" = $1
          OR ($2::text IS NOT NULL AND s."advocacy_group_id" = $2)
          OR (
            $2::text IS NULL
            AND s."advocacy_group_id" IS NOT NULL
            AND EXISTS (SELECT 1 FROM "SessionAttendance" sa_fb
                        WHERE sa_fb."session_id" = s."id" AND sa_fb."mom_id" = $3 AND sa_fb."deleted_at" = 0)
            AND EXISTS (SELECT 1 FROM "AdvocacyGroup" ag_fb
                        WHERE ag_fb."id" = s."advocacy_group_id" AND ag_fb."deleted_at" = 0
                          AND ($4::text IS NULL OR ag_fb."trackId" = $4))
            AND EXISTS (SELECT 1 FROM "Pairing" pr_fb
                        WHERE pr_fb."id" = $1
                          AND (s."date_start" IS NULL OR (
                            s."date_start" >= pr_fb."created_at" - INTERVAL '14 days'
                            AND (pr_fb."completed_on" IS NULL
                                 OR s."date_start" <= pr_fb."completed_on" + INTERVAL '14 days'))))
          )
        )
      ORDER BY s."date_start" NULLS LAST
    `, [p.id, p.gid, MOM_ID, TRACK_RR]);
    console.log('\n=== ' + p.label + ' ===');
    rows.forEach(r => console.log(' ', r.date_start ? r.date_start.toISOString().slice(0,10) : 'no-date', '|', r.attended || 'n/a', '|', r.name));
    console.log('  total:', rows.length);
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
