/* ============================================================
   /api/kpi1-breakdown — KPI 1 Family Preservation Breakdown
   Administrator only. Returns goal + impact breakdown for the
   preservation breakdown HQ resource page.
   ============================================================ */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'administrator') return next();
  res.status(403).json({ error: 'Access denied' });
}

// Child snapshot: intake welfare status per child (for goal derivation)
let CHILD_SNAPSHOT_MAP = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, '../data/child-snapshot.json'), 'utf8').replace(/^﻿/, '');
  const rows = JSON.parse(raw);
  for (const r of rows) {
    if (r.child_id) CHILD_SNAPSHOT_MAP[r.child_id] = r.active_child_welfare_involvement || null;
  }
  console.log(`[kpi1-breakdown] loaded ${Object.keys(CHILD_SNAPSHOT_MAP).length} snapshot entries`);
} catch (err) {
  console.error('[kpi1-breakdown] failed to load child-snapshot.json:', err.message);
}

// Map intake welfare status → family preservation goal (matches report-data.js)
function mapGoal(intakeStatus) {
  const s = (intakeStatus || '').trim().toLowerCase();
  if (s === '30_custody_maintained' || s === '25_supportive_services')
    return 'prevent_cps_involvement';
  if (s === '20_differential_response' || s === '15_open_investigation' || s === '10_protective_services')
    return 'prevent_foster_care_placement';
  if (s === '5_kinship_placement' || s === '0_foster_care')
    return 'prevent_permanent_removal';
  if (s === '0_permanently_removed')
    return 'not_eligible_program';
  return null;
}

// Map goal + latest welfare status → impact (matches report-data.js)
function mapImpact(goal, latestStatus) {
  const l = (latestStatus || '').trim().toLowerCase();
  if (!goal || goal === 'not_eligible_program') return null;
  if (l === '0_permanently_removed') return 'permanent_removal';

  if (goal === 'prevent_cps_involvement') {
    if (l === '30_custody_maintained' || l === '25_supportive_services') return 'prevented_from_cps_involvement';
    if (l === '20_differential_response' || l === '15_open_investigation' || l === '10_protective_services') return 'prevented_from_foster_care_placement';
    if (l === '0_foster_care' || l === '5_kinship_placement') return 'temporary_removal';
    return null;
  }

  if (goal === 'prevent_foster_care_placement') {
    if (l === '30_custody_maintained' || l === '25_supportive_services' ||
        l === '20_differential_response' || l === '15_open_investigation' ||
        l === '10_protective_services') return 'prevented_from_foster_care_placement';
    if (l === '0_foster_care' || l === '5_kinship_placement') return 'temporary_removal';
    return null;
  }

  if (goal === 'prevent_permanent_removal') return null;

  return null;
}

// GET /api/kpi1-breakdown?period=q1|q2
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const period = (req.query.period || 'q2').toLowerCase();

    let PERIOD_START, PERIOD_END, PERIOD_LABEL, FWA_WINDOW;
    if (period === 'q1') {
      PERIOD_START = '2026-01-01'; PERIOD_END = '2026-03-31';
      PERIOD_LABEL = 'Q1 2026';     FWA_WINDOW = '3-month';
    } else if (period === 'q2') {
      PERIOD_START = '2026-01-01'; PERIOD_END = '2026-06-30';
      PERIOD_LABEL = 'Q2 2026 YTD'; FWA_WINDOW = '6-month';
    } else {
      return res.status(400).json({ error: 'Invalid period — use q1 or q2' });
    }

    // Fetch all children in eligible families (moms with a scored FWA in period)
    const result = await pool.query(`
      WITH moms_with_period_fwa AS (
        SELECT DISTINCT wa."mom_id" AS "momId"
        FROM "WellnessAssessment" wa
        JOIN "Mom" m ON m."id" = wa."mom_id"
        WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
          AND wa."cpi_total" IS NOT NULL
          AND wa."updated_at" >= $1
          AND wa."updated_at" <= $2
      )
      SELECT
        c."id"                                AS child_id,
        c."mom_id",
        c."active_child_welfare_involvement"::text AS latest_status
      FROM "Child" c
      JOIN moms_with_period_fwa f ON f."momId" = c."mom_id"
      WHERE c."deleted_at" = 0
      ORDER BY c."mom_id", c."id"
    `, [PERIOD_START, PERIOD_END + ' 23:59:59']);

    const children = result.rows;
    const denominator = children.length;

    // ── Goal breakdown (from snapshot intake status) ──────────────────────────
    const goalCounts = {
      prevent_cps_involvement:       0,
      prevent_foster_care_placement: 0,
      prevent_permanent_removal:     0,
      not_eligible_program:          0,
      not_recorded:                  0,
    };

    // ── Impact breakdown (from Child.family_preservation_impact) ─────────────
    const impactCounts = {
      prevented_from_cps_involvement:       0,
      prevented_from_foster_care_placement: 0,
      temporary_removal:                    0,
      permanent_removal:                    0,
      not_yet_recorded:                     0,
    };

    for (const c of children) {
      // Goal from snapshot intake status
      const intakeStatus = CHILD_SNAPSHOT_MAP[c.child_id] || null;
      const goal = mapGoal(intakeStatus);
      if      (goal === 'prevent_cps_involvement')       goalCounts.prevent_cps_involvement++;
      else if (goal === 'prevent_foster_care_placement') goalCounts.prevent_foster_care_placement++;
      else if (goal === 'prevent_permanent_removal')     goalCounts.prevent_permanent_removal++;
      else if (goal === 'not_eligible_program')          goalCounts.not_eligible_program++;
      else                                               goalCounts.not_recorded++;

      // Impact computed from snapshot intake + live latest status
      const impact = mapImpact(goal, c.latest_status);
      if      (impact === 'prevented_from_cps_involvement')       impactCounts.prevented_from_cps_involvement++;
      else if (impact === 'prevented_from_foster_care_placement') impactCounts.prevented_from_foster_care_placement++;
      else if (impact === 'temporary_removal')                    impactCounts.temporary_removal++;
      else if (impact === 'permanent_removal')                    impactCounts.permanent_removal++;
      else                                                        impactCounts.not_yet_recorded++;
    }

    const numerator = impactCounts.prevented_from_cps_involvement +
                      impactCounts.prevented_from_foster_care_placement;

    res.json({
      period,
      periodLabel:   PERIOD_LABEL,
      fwaWindow:     FWA_WINDOW,
      target:        85,
      dollarPerChild: 38850,
      denominator,
      numerator,
      goal:   goalCounts,
      impact: impactCounts,
    });
  } catch (err) {
    console.error('[kpi1-breakdown]', err);
    res.status(500).json({ error: 'Query failed' });
  }
});

module.exports = router;
