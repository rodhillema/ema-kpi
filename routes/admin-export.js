const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const EXPORT_WHITELIST = ['rd.hill'];

function requireExportAdmin(req, res, next) {
  const username = (req.session.user.username || '').toLowerCase();
  if (!EXPORT_WHITELIST.includes(username)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

router.use(requireAuth, requireExportAdmin);

// GET /api/admin/export/staff — coordinators, supervisors, administrators
router.get('/staff', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u."firstName", u."lastName", u."username" AS email,
             r."key" AS role, a."name" AS affiliate
      FROM "User" u
      JOIN "UserRole" ur ON ur."user_id" = u."id" AND ur."deleted_at" = '0'
      JOIN "Role" r ON r."id" = ur."role_id"
      LEFT JOIN "Affiliate" a ON a."id" = u."affiliateId"
      WHERE u."deleted_at" = 0
        AND r."key" IN ('coordinator', 'supervisor', 'administrator')
      ORDER BY r."key", a."name", u."lastName"
    `);
    console.log(`[ADMIN-EXPORT] ${req.session.user.username} exported staff list (${rows.length} rows)`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Staff export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/admin/export/advocates — all advocate users with status
router.get('/advocates', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u."firstName", u."lastName", u."username" AS email,
             u."advocate_status"::text AS status,
             u."advocate_sub_status"::text AS sub_status,
             a."name" AS affiliate
      FROM "User" u
      LEFT JOIN "Affiliate" a ON a."id" = u."affiliateId"
      WHERE u."deleted_at" = 0
        AND u."advocate_status" IS NOT NULL
      ORDER BY a."name", u."advocate_status"::text, u."lastName"
    `);
    console.log(`[ADMIN-EXPORT] ${req.session.user.username} exported advocates (${rows.length} rows)`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Advocate export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/admin/export/moms — active moms with affiliate and pairing status
router.get('/moms', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m."first_name", m."last_name", m."status"::text AS status,
             a."name" AS affiliate,
             CASE WHEN EXISTS (
               SELECT 1 FROM "Pairing" p
               WHERE p."momId" = m."id" AND p."deleted_at" = 0 AND p."status"::text = 'paired'
             ) THEN 'paired' ELSE 'not paired' END AS pairing_status,
             m."date_entered"::date AS intake_date
      FROM "Mom" m
      LEFT JOIN "Affiliate" a ON a."id" = m."affiliate_id"
      WHERE m."deleted_at" = 0
      ORDER BY a."name", m."status"::text, m."last_name"
    `);
    console.log(`[ADMIN-EXPORT] ${req.session.user.username} exported moms (${rows.length} rows)`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Mom export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/admin/export/affiliates — affiliate list with counts
router.get('/affiliates', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a."id", a."name",
             COUNT(DISTINCT CASE WHEN m."status"::text = 'active' THEN m."id" END)::int AS active_moms,
             COUNT(DISTINCT CASE WHEN p."status"::text = 'paired' THEN p."advocateUserId" END)::int AS active_advocates
      FROM "Affiliate" a
      LEFT JOIN "Mom" m ON m."affiliate_id" = a."id" AND m."deleted_at" = 0
      LEFT JOIN "Pairing" p ON p."momId" = m."id" AND p."deleted_at" = 0
      WHERE a."deleted_at" = 0
      GROUP BY a."id", a."name"
      ORDER BY a."name"
    `);
    console.log(`[ADMIN-EXPORT] ${req.session.user.username} exported affiliates (${rows.length} rows)`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Affiliate export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/admin/export/champions — champion users
router.get('/champions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c."firstName", c."lastName", c."username" AS email,
             c."status", a."name" AS affiliate,
             c."created_at"::date AS created
      FROM "ChampionUser" c
      LEFT JOIN "Affiliate" a ON a."id" = c."affiliateId"
      WHERE c."deleted_at" = 0
      ORDER BY c."status", a."name", c."lastName"
    `);
    console.log(`[ADMIN-EXPORT] ${req.session.user.username} exported champions (${rows.length} rows)`);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Champion export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/admin/export/lesson-gaps
// Org-wide discovery of pairings where sessions exist but lesson_template_id is NULL.
// Three buckets:
//   1. untemplated1on1  — active 1:1 pairings with ≥1 session missing a lesson link
//   2. untemplatedGroups — active groups (via active pairings) with ≥1 session missing a lesson link
//   3. noSessions       — active pairings with zero sessions logged at all
// Also returns per-affiliate rollup counts.
router.get('/lesson-gaps', async (req, res) => {
  try {
    const [r1, r2, r3] = await Promise.all([

      // 1:1 pairings — untemplated session counts
      pool.query(`
        SELECT
          p."id"                                                          AS "pairingId",
          m."first_name" || ' ' || m."last_name"                         AS "momName",
          a."name"                                                        AS "affiliate",
          t."title"                                                       AS "trackTitle",
          COALESCE(uc."firstName" || ' ' || uc."lastName", '')           AS "coordinator",
          COUNT(s."id")::int                                              AS "totalSessions",
          COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END)::int AS "untemplatedSessions",
          COUNT(CASE WHEN s."lesson_template_id" IS NOT NULL THEN 1 END)::int AS "templatedSessions",
          MAX(s."date_start")::date                                       AS "lastSessionDate"
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
        LEFT JOIN "Affiliate" a ON a."id" = m."affiliate_id"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        LEFT JOIN "User" uc ON uc."id" = m."assigned_user_id"
        JOIN "Session" s ON s."pairing_id" = p."id" AND s."deleted_at" = 0
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."advocacyGroupId" IS NULL
        GROUP BY p."id", m."first_name", m."last_name", a."name", t."title", uc."firstName", uc."lastName"
        HAVING COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END) > 0
        ORDER BY COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END) DESC, a."name", m."last_name"
      `),

      // Group sessions — untemplated session counts per AdvocacyGroup
      pool.query(`
        SELECT
          ag."id"                                                          AS "groupId",
          ag."name"                                                        AS "groupName",
          t."title"                                                        AS "trackTitle",
          (
            SELECT af."name"
            FROM "Pairing" p2
            JOIN "Mom" m2 ON m2."id" = p2."momId" AND m2."deleted_at" = 0
            LEFT JOIN "Affiliate" af ON af."id" = m2."affiliate_id"
            WHERE p2."advocacyGroupId" = ag."id"
              AND p2."deleted_at" = 0
              AND p2."status"::text = 'paired'
            LIMIT 1
          )                                                                AS "affiliate",
          COUNT(DISTINCT p."momId")::int                                  AS "momCount",
          COUNT(s."id")::int                                              AS "totalSessions",
          COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END)::int AS "untemplatedSessions",
          COUNT(CASE WHEN s."lesson_template_id" IS NOT NULL THEN 1 END)::int AS "templatedSessions",
          MAX(s."date_start")::date                                       AS "lastSessionDate"
        FROM "AdvocacyGroup" ag
        JOIN "Pairing" p ON p."advocacyGroupId" = ag."id"
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
        LEFT JOIN "Track" t ON t."id" = ag."trackId"
        JOIN "Session" s ON s."advocacy_group_id" = ag."id" AND s."deleted_at" = 0
        WHERE ag."deleted_at" = 0
        GROUP BY ag."id", ag."name", t."title"
        HAVING COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END) > 0
        ORDER BY COUNT(CASE WHEN s."lesson_template_id" IS NULL THEN 1 END) DESC
      `),

      // Active pairings with zero sessions logged
      pool.query(`
        SELECT
          p."id"                                    AS "pairingId",
          m."first_name" || ' ' || m."last_name"   AS "momName",
          a."name"                                  AS "affiliate",
          t."title"                                 AS "trackTitle",
          p."created_at"::date                      AS "startDate",
          CASE WHEN p."advocacyGroupId" IS NULL THEN '1:1' ELSE 'group' END AS "deliveryType"
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
        LEFT JOIN "Affiliate" a ON a."id" = m."affiliate_id"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND NOT EXISTS (
            SELECT 1 FROM "Session" s
            WHERE (
              s."pairing_id" = p."id"
              OR (p."advocacyGroupId" IS NOT NULL AND s."advocacy_group_id" = p."advocacyGroupId")
            )
            AND s."deleted_at" = 0
          )
        ORDER BY p."created_at" ASC
      `),

    ]);

    const untemplated1on1   = r1.rows;
    const untemplatedGroups = r2.rows;
    const noSessions        = r3.rows;

    // Per-affiliate rollup
    const affMap = {};
    const bump = (aff, key) => {
      if (!affMap[aff]) affMap[aff] = { affiliate: aff, untemplated1on1: 0, untemplatedGroups: 0, noSessions: 0 };
      affMap[aff][key]++;
    };
    untemplated1on1.forEach(r => bump(r.affiliate || 'Unknown', 'untemplated1on1'));
    untemplatedGroups.forEach(r => bump(r.affiliate || 'Unknown', 'untemplatedGroups'));
    noSessions.forEach(r => bump(r.affiliate || 'Unknown', 'noSessions'));
    const byAffiliate = Object.values(affMap).sort((a, b) => a.affiliate.localeCompare(b.affiliate));

    const summary = {
      untemplated1on1Pairings: untemplated1on1.length,
      untemplatedGroupSessions: untemplatedGroups.length,
      noSessionsPairings: noSessions.length,
    };

    console.log(`[ADMIN-EXPORT] ${req.session.user.username} ran lesson-gap report (${JSON.stringify(summary)})`);
    res.json({ summary, byAffiliate, untemplated1on1, untemplatedGroups, noSessions });
  } catch (err) {
    console.error('Lesson gap report error:', err);
    res.status(500).json({ error: 'Lesson gap report failed', detail: err.message });
  }
});

module.exports = router;
