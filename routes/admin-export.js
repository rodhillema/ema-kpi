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

module.exports = router;
