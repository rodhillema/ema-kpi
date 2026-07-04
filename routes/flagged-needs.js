const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// Administrator only
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'administrator') return next();
  res.status(403).json({ error: 'Access denied' });
}

// GET /api/flagged-needs?period=q1|q2|ytd&year=2026
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const period = (req.query.period || 'q1').toLowerCase();

    let startDate, endDate;
    if (period === 'q1') {
      startDate = `${year}-01-01`;
      endDate   = `${year}-04-01`;
    } else if (period === 'q2') {
      startDate = `${year}-04-01`;
      endDate   = `${year}-07-01`;
    } else if (period === 'ytd') {
      startDate = `${year}-01-01`;
      endDate   = `${year + 1}-01-01`;
    } else {
      return res.status(400).json({ error: 'Invalid period — use q1, q2, or ytd' });
    }

    const q = `
      SELECT
        COALESCE(af.name, 'Unknown')      AS affiliate_name,
        COALESCE(bn."type_c"::text, 'Other') AS need_type,
        COUNT(*)::int                        AS flagged,
        SUM(CASE WHEN bn."did_address_need_c" = TRUE THEN 1 ELSE 0 END)::int AS met
      FROM "BenevolenceNeed" bn
      JOIN "Mom" m ON m."id" = bn."momId"
      LEFT JOIN "Affiliate" af ON af."id" = m."affiliate_id"
      WHERE bn."created_at" >= $1
        AND bn."created_at" <  $2
        AND bn."deleted_at" = 0
      GROUP BY af.name, bn."type_c"
      ORDER BY COUNT(*) DESC, af.name
    `;

    const result = await pool.query(q, [startDate, endDate]);
    const rows = result.rows;

    // Roll up by affiliate
    const affiliateMap = {};
    for (const r of rows) {
      const aff = r.affiliate_name;
      if (!affiliateMap[aff]) affiliateMap[aff] = { affiliate: aff, flagged: 0, met: 0 };
      affiliateMap[aff].flagged += r.flagged;
      affiliateMap[aff].met    += r.met;
    }

    // Roll up by need type
    const typeMap = {};
    for (const r of rows) {
      const t = r.need_type;
      if (!typeMap[t]) typeMap[t] = { type: t, flagged: 0, met: 0 };
      typeMap[t].flagged += r.flagged;
      typeMap[t].met     += r.met;
    }

    const totalFlagged = rows.reduce((s, r) => s + r.flagged, 0);
    const totalMet     = rows.reduce((s, r) => s + r.met, 0);

    res.json({
      period,
      year,
      startDate,
      endDate,
      total: { flagged: totalFlagged, met: totalMet },
      byAffiliate: Object.values(affiliateMap).sort((a, b) => b.flagged - a.flagged),
      byType: Object.values(typeMap).sort((a, b) => b.flagged - a.flagged),
    });
  } catch (err) {
    console.error('[flagged-needs]', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

module.exports = router;
