#!/usr/bin/env node
/* Probe 2: session lesson linkage + ActionItem subtasks + exact route query test.
   Usage: railway run node scripts/probe-court-summary2.js */

'use strict';
const pool = require('../db');

const MOM_ID = 'fa77884f-342d-4069-9006-31b5a1a666ef';
const PAIRING_JUNE = '0ca25cb5-af63-4c15-8d23-95b042a2e229'; // RR Jun 1 – Jul 8
const GROUP_JUNE = 'a9085fb6-67d2-4543-a9da-5eaaa891f0b5';
const TRACK_RR = '98831f87-690f-4b62-a7a0-ef8d95436d7e';

async function run() {
  // 1. Session columns incl. lesson_template_id + name for her group sessions
  const sess = await pool.query(`
    SELECT s."id", s."name", s."lesson_template_id" AS tpl, s."date_start",
           s."session_type"::text AS type, s."advocacy_group_id" AS gid
    FROM "Session" s
    WHERE s."advocacy_group_id" IN ($1, 'f1479f86-dd11-4590-9cf8-7bbbd4b27b0b')
      AND s."deleted_at" = 0
    ORDER BY s."date_start" NULLS LAST
  `, [GROUP_JUNE]);
  console.log('=== GROUP SESSIONS (name + lesson_template_id) ===');
  console.log(JSON.stringify(sess.rows, null, 2));

  // 2. LessonTemplates for RR track
  const lt = await pool.query(`
    SELECT lt."id", lt."title", lt."order"
    FROM "LessonTemplate" lt
    WHERE lt."track_id" = $1 AND lt."deleted_at" = 0
    ORDER BY lt."order"
  `, [TRACK_RR]);
  console.log('\n=== RR LESSON TEMPLATES ===');
  console.log(JSON.stringify(lt.rows, null, 2));

  // 3. ActionItems for Amber's active goals
  const items = await pool.query(`
    SELECT ai."goalId", ai."name", ai."dueDate", ai."doneDate", ai."deleted_at"
    FROM "ActionItem" ai
    WHERE ai."goalId" IN (SELECT g."id" FROM "Goal" g WHERE g."momId" = $1 AND g."deleted_at" = 0)
    ORDER BY ai."goalId", ai."dueDate"
  `, [MOM_ID]);
  console.log('\n=== ACTION ITEMS (subtasks of active goals) ===');
  console.log(JSON.stringify(items.rows, null, 2));

  // 4. Run the EXACT session WHERE clause from the deployed route for the June pairing
  const routeTest = await pool.query(`
    SELECT s."id", s."date_start", sa."status"::text AS attended
    FROM "Session" s
    LEFT JOIN "SessionAttendance" sa
      ON sa."session_id" = s."id" AND sa."mom_id" = $3 AND sa."deleted_at" = 0
    WHERE s."deleted_at" = 0
      AND (
        s."pairing_id" = $1
        OR ($2::text IS NOT NULL AND s."advocacy_group_id" = $2)
        OR (
          s."advocacy_group_id" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "SessionAttendance" sa_fb
                      WHERE sa_fb."session_id" = s."id" AND sa_fb."mom_id" = $3 AND sa_fb."deleted_at" = 0)
          AND EXISTS (SELECT 1 FROM "AdvocacyGroup" ag_fb
                      WHERE ag_fb."id" = s."advocacy_group_id" AND ag_fb."deleted_at" = 0
                        AND ($4::text IS NULL OR ag_fb."trackId" = $4))
        )
      )
    ORDER BY s."date_start" NULLS LAST
  `, [PAIRING_JUNE, GROUP_JUNE, MOM_ID, TRACK_RR]);
  console.log('\n=== ROUTE SESSION QUERY TEST (June RR pairing) ===');
  console.log(JSON.stringify(routeTest.rows, null, 2));

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
