#!/usr/bin/env node
/* One-time probe: diagnose court-summary data for Amber Fernandez.
   Usage: railway run node scripts/probe-court-summary.js */

'use strict';
const pool = require('../db');

async function run() {
  // 1. Goal + ActionItem columns
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('Goal', 'ActionItem')
    ORDER BY table_name, ordinal_position
  `);
  console.log('\n=== Goal / ActionItem COLUMNS ===');
  let cur = '';
  cols.rows.forEach(r => {
    if (r.table_name !== cur) { cur = r.table_name; console.log('\n-- ' + cur); }
    console.log('  ', r.column_name, '(' + r.data_type + ')');
  });

  // 2. Amber's pairings
  const pairings = await pool.query(`
    SELECT p."id", p."trackId", p."advocacyGroupId", p."advocacy_type"::text AS type,
           p."status"::text AS status, p."created_at", p."completed_on",
           t."title" AS track
    FROM "Pairing" p
    JOIN "Mom" m ON m."id" = p."momId"
    LEFT JOIN "Track" t ON t."id" = p."trackId"
    WHERE m."first_name" = 'Amber' AND m."last_name" = 'Fernandez'
      AND p."deleted_at" = 0
    ORDER BY p."created_at"
  `);
  console.log('\n=== AMBER PAIRINGS ===');
  console.log(JSON.stringify(pairings.rows, null, 2));

  const momRow = await pool.query(`
    SELECT "id" FROM "Mom" WHERE "first_name" = 'Amber' AND "last_name" = 'Fernandez' LIMIT 1
  `);
  const momId = momRow.rows[0].id;

  // 3. Her attended sessions w/ note info
  const sess = await pool.query(`
    SELECT s."id", s."session_type"::text AS type, s."date_start", s."status"::text AS sstatus,
           s."advocacy_group_id" AS gid, s."pairing_id" AS pid,
           sa."status"::text AS attended,
           (SELECT COUNT(*)::int FROM "SessionNote" sn WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0) AS notes,
           (SELECT sn."status"::text FROM "SessionNote" sn WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0 LIMIT 1) AS note_status,
           (SELECT sn."covered_lesson_id" FROM "SessionNote" sn WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0 LIMIT 1) AS covered_lesson
    FROM "SessionAttendance" sa
    JOIN "Session" s ON s."id" = sa."session_id" AND s."deleted_at" = 0
    WHERE sa."mom_id" = $1 AND sa."deleted_at" = 0
    ORDER BY s."date_start"
  `, [momId]);
  console.log('\n=== AMBER ATTENDED SESSIONS ===');
  console.log(JSON.stringify(sess.rows, null, 2));

  // 4. Lessons for her pairings / groups
  const lessons = await pool.query(`
    SELECT l."id", l."pairing_id", l."source_lesson_template_id" AS tpl,
           l."status"::text AS status, l."title", l."order"
    FROM "Lesson" l
    WHERE l."pairing_id" IN (
      SELECT p."id" FROM "Pairing" p WHERE p."momId" = $1 AND p."deleted_at" = 0
    )
    ORDER BY l."order"
  `, [momId]);
  console.log('\n=== LESSONS (by pairing_id) ===');
  console.log(JSON.stringify(lessons.rows, null, 2));

  // 5. Lesson table columns (to see what links group lessons)
  const lcols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Lesson'
    ORDER BY ordinal_position
  `);
  console.log('\n=== Lesson COLUMNS ===');
  console.log(lcols.rows.map(r => r.column_name).join(', '));

  // 6. Lessons linked to her groups (if such a column exists)
  const hasGroupCol = lcols.rows.some(r => r.column_name === 'advocacy_group_id');
  if (hasGroupCol) {
    const glessons = await pool.query(`
      SELECT l."id", l."advocacy_group_id", l."source_lesson_template_id" AS tpl,
             l."status"::text AS status, l."title", l."order"
      FROM "Lesson" l
      WHERE l."advocacy_group_id" IN (
        SELECT DISTINCT s."advocacy_group_id" FROM "SessionAttendance" sa
        JOIN "Session" s ON s."id" = sa."session_id"
        WHERE sa."mom_id" = $1 AND s."advocacy_group_id" IS NOT NULL
      )
      ORDER BY l."order"
    `, [momId]);
    console.log('\n=== LESSONS (by advocacy_group_id) ===');
    console.log(JSON.stringify(glessons.rows, null, 2));
  }

  // 7. Goals for Amber — try mom_id and pairing_id linkage
  const gcols = cols.rows.filter(r => r.table_name === 'Goal').map(r => r.column_name);
  console.log('\n=== Goal columns ===', gcols.join(', '));
  let goalWhere = null;
  if (gcols.includes('mom_id')) goalWhere = `g."mom_id" = $1`;
  else if (gcols.includes('momId')) goalWhere = `g."momId" = $1`;
  else if (gcols.includes('pairing_id')) goalWhere = `g."pairing_id" IN (SELECT p."id" FROM "Pairing" p WHERE p."momId" = $1)`;
  if (goalWhere) {
    const goals = await pool.query(`SELECT g.* FROM "Goal" g WHERE ${goalWhere} LIMIT 10`, [momId]);
    console.log('\n=== AMBER GOALS ===');
    console.log(JSON.stringify(goals.rows, null, 2));
  }

  // 8. Her assessments
  const assess = await pool.query(`
    SELECT ar."id", a."name", ar."type"::text AS type,
           ar."completedAt", ar."lastSaved",
           (SELECT SUM(arqr."intResponse")::int FROM "AssessmentResultQuestionResponse" arqr
            WHERE arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL) AS total
    FROM "AssessmentResult" ar
    JOIN "Assessment" a ON a."id" = ar."assessmentId"
    WHERE ar."momId" = $1 AND ar."deleted_at" = 0
    ORDER BY COALESCE(ar."completedAt", ar."lastSaved")
  `, [momId]);
  console.log('\n=== AMBER ASSESSMENTS ===');
  console.log(JSON.stringify(assess.rows, null, 2));

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
