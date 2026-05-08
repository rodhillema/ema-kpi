const express = require('express');
const router = express.Router();
const pool = require('../db');

const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-04-01'; // exclusive upper bound

// GET /api/flagged-needs
// Returns three result sets: overall, by type_c, by affiliate.
// Affiliate-scoped for coordinator/staff_advocate/supervisor; org-wide for administrator.
router.get('/', async (req, res) => {
  try {
    const { role, affiliate_id } = req.session.user;
    const ORG_WIDE_ROLES = ['administrator'];
    const isOrgWide = ORG_WIDE_ROLES.includes(role);

    // Affiliate filter clause — injected into each query
    const affWhere = isOrgWide ? '' : `AND m."affiliate_id" = $3`;
    const affParam = isOrgWide ? [] : [affiliate_id];

    // ── 1. Overall ──────────────────────────────────────────────────────────
    const overallSQL = `
      SELECT
        COUNT(*)                                                        AS total_flagged,
        SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END) AS total_met,
        ROUND(
          SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
          * 100.0 / NULLIF(COUNT(*), 0)
        )                                                               AS pct_met
      FROM "BenevolenceNeed" bn
      ${isOrgWide ? '' : 'JOIN "Mom" m ON m."id" = bn."momId" AND m."deleted_at" = 0'}
      WHERE bn."created_at" >= $1
        AND bn."created_at" <  $2
        AND bn."deleted_at" = 0
        AND bn."legacy_ps_id" IS NULL
        ${affWhere}
    `;

    // ── 2. By type_c ────────────────────────────────────────────────────────
    const byTypeSQL = `
      SELECT
        bn."type_c",
        COUNT(*)                                                        AS total_flagged,
        SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END) AS total_met,
        ROUND(
          SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
          * 100.0 / NULLIF(COUNT(*), 0)
        )                                                               AS pct_met
      FROM "BenevolenceNeed" bn
      ${isOrgWide ? '' : 'JOIN "Mom" m ON m."id" = bn."momId" AND m."deleted_at" = 0'}
      WHERE bn."created_at" >= $1
        AND bn."created_at" <  $2
        AND bn."deleted_at" = 0
        AND bn."legacy_ps_id" IS NULL
        ${affWhere}
      GROUP BY bn."type_c"
      ORDER BY total_flagged DESC
    `;

    // ── 3. By affiliate ─────────────────────────────────────────────────────
    // Always joins Mom + Affiliate so we can report affiliate_name.
    // For coordinator-scoped users, filtered to their single affiliate.
    const byAffiliateSQL = `
      SELECT
        a."name"                                                        AS affiliate_name,
        COUNT(*)                                                        AS total_flagged,
        SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END) AS total_met,
        ROUND(
          SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)
          * 100.0 / NULLIF(COUNT(*), 0)
        )                                                               AS pct_met,
        COUNT(*) < 5                                                    AS small_sample
      FROM "BenevolenceNeed" bn
      JOIN "Mom" m ON m."id" = bn."momId" AND m."deleted_at" = 0
      JOIN "Affiliate" a ON a."id" = m."affiliate_id" AND a."deleted_at" = 0
      WHERE bn."created_at" >= $1
        AND bn."created_at" <  $2
        AND bn."deleted_at" = 0
        AND bn."legacy_ps_id" IS NULL
        ${affWhere}
      GROUP BY a."id", a."name"
      ORDER BY total_flagged DESC
    `;

    const params = [PERIOD_START, PERIOD_END, ...affParam];

    const [overall, byType, byAffiliate] = await Promise.all([
      pool.query(overallSQL, params),
      pool.query(byTypeSQL, params),
      pool.query(byAffiliateSQL, params),
    ]);

    res.json({
      period: { start: PERIOD_START, end: '2026-03-31' },
      overall: overall.rows[0],
      by_type: byType.rows,
      by_affiliate: byAffiliate.rows,
    });
  } catch (err) {
    console.error('Flagged needs error:', err);
    res.status(500).json({ error: 'Failed to load flagged needs data' });
  }
});

module.exports = router;
