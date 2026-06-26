/* ============================================================
   Child Welfare Status Review — API
   GET /api/child-welfare
   HQ admin only (administrator role or org-wide whitelist).
   One row per child from ChildSnapshot, joined to live Child,
   Mom, Affiliate, and most-recent Pairing records.
   ============================================================ */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole);

router.get('/', async (req, res) => {
  const user = req.session.user;

  // HQ admin only — administrator role or org-wide whitelisted users
  if (user.role !== 'administrator' && !user.isOrgWide) {
    return res.status(403).json({ error: 'Child Welfare Status Review is restricted to HQ administrators.' });
  }

  try {
    const params  = [];
    const addParam = (v) => { params.push(v); return `$${params.length}`; };

    // Optional affiliate filter (admin UI slicer)
    const affFilter = req.query.affiliate_id
      ? `AND cs."affiliate_id" = ${addParam(req.query.affiliate_id)}`
      : '';

    const query = `
      WITH latest_pairing AS (
        -- Most-recent pairing per mom (active or completed)
        SELECT DISTINCT ON (p."momId")
          p."momId"                                   AS mom_id,
          p."id"                                      AS pairing_id,
          p."status"::text                            AS pairing_status,
          p."complete_reason_sub_status"::text        AS complete_reason
        FROM "Pairing" p
        WHERE p."deleted_at" = 0
          AND (p."status"::text = 'paired'
            OR p."status"::text = 'pairing_complete'
            OR p."complete_reason_sub_status" IS NOT NULL)
        ORDER BY p."momId", p."createdAt" DESC NULLS LAST
      )
      SELECT
        cs."id"                                       AS snapshot_id,
        cs."child_id",
        cs."mom_id",
        cs."affiliate_id",
        a."name"                                      AS affiliate_name,
        m."firstName" || ' ' || m."lastName"         AS mom_name,
        NULLIF(TRIM(cs."first_name"), '')             AS child_name,
        cs."birthdate",
        m."created_at"                                AS intake_date,
        cs."active_child_welfare_involvement"         AS intake_welfare_status,
        cs."family_preservation_goal"                 AS intake_goal,
        c."active_child_welfare_involvement"          AS latest_welfare_status,
        cs."child_updated_at"                         AS record_updated,
        cs."changed_by_name"                          AS updated_by,
        m."status"::text                              AS mom_status,
        lp.complete_reason,
        lp.pairing_status,
        lp.pairing_id
      FROM "ChildSnapshot" cs
      JOIN "Mom" m
        ON m."id" = cs."mom_id"
       AND m."deleted_at" = 0
      LEFT JOIN "Affiliate" a
        ON a."id" = cs."affiliate_id"
      LEFT JOIN "Child" c
        ON c."id" = cs."child_id"
      LEFT JOIN latest_pairing lp
        ON lp.mom_id = cs."mom_id"
      WHERE 1=1
        ${affFilter}
      ORDER BY
        m."lastName"   ASC NULLS LAST,
        m."firstName"  ASC NULLS LAST,
        COALESCE(NULLIF(TRIM(cs."first_name"), ''), 'zzz') ASC
    `;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[child-welfare] query error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load child welfare data.' });
  }
});

module.exports = router;
