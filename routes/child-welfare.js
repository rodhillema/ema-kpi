/* ============================================================
   Child Welfare Status Review — API
   GET /api/child-welfare
   HQ admin only (administrator role or org-wide whitelist).

   Inclusion rule (canonical):
   A child row appears only if the mom qualifies via Pairing:
   1. Active in a track (status='paired', any advocacy_type) — always include;
      mark intake_missing=true if no welfare status at intake.
   2. Completed a track YTD (status='pairing_complete' + completed reason +
      completed_on >= YTD_START) — include only if intake welfare status exists.
   ============================================================ */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const pool     = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole);

const COMPLETED_REASONS = [
  'completed_full_track',
  'completed_without_post_assessment',
  'completed_without_support_sessions',
];
const YTD_START = '2026-01-01';

// Load snapshot data once at startup
const SNAPSHOT_PATH = path.join(__dirname, '../data/child-snapshot.json');
let SNAPSHOT_ROWS = [];
try {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8').replace(/^﻿/, '');
  SNAPSHOT_ROWS = JSON.parse(raw);
  console.log(`[child-welfare] loaded ${SNAPSHOT_ROWS.length} ChildSnapshot rows from JSON`);
} catch (err) {
  console.error('[child-welfare] failed to load child-snapshot.json:', err.message);
}

router.get('/', async (req, res) => {
  const user = req.session.user;

  const ALLOWED_CW_ROLES = ['administrator', 'supervisor', 'coordinator'];
  if (!ALLOWED_CW_ROLES.includes(user.role) && !user.isOrgWide) {
    return res.status(403).json({ error: 'Child Welfare Status Review is not available for your role.' });
  }

  try {
    // ── Step 1: qualifying moms from Trellis V1 Pairing ──────────────────────
    const pairingsResult = await pool.query(
      `SELECT DISTINCT ON (p."momId")
         p."momId"                              AS mom_id,
         p."id"                                 AS pairing_id,
         p."status"::text                       AS pairing_status,
         p."complete_reason_sub_status"::text   AS complete_reason,
         p."advocacy_type"::text                AS advocacy_type,
         p."advocacyGroupId"                    AS advocacy_group_id,
         p."completed_on"                       AS pairing_completed_on
       FROM "Pairing" p
       WHERE p."deleted_at" = 0
         AND (
           p."status"::text = 'paired'
           OR (
             p."status"::text = 'pairing_complete'
             AND p."complete_reason_sub_status"::text = ANY($1)
             AND p."completed_on" >= $2
           )
         )
       ORDER BY p."momId", p."created_at" DESC NULLS LAST`,
      [COMPLETED_REASONS, YTD_START]
    ).catch(err => {
      console.error('[child-welfare] pairing inclusion query failed:', err.message);
      return { rows: [] };
    });

    const qualifyingPairings = Object.fromEntries(
      pairingsResult.rows.map(r => [r.mom_id, r])
    );
    const qualifyingMomIds = new Set(Object.keys(qualifyingPairings));

    // ── Step 2: filter snapshot to qualifying moms + optional affiliate ───────
    // Org-wide users can pass affiliate_id to scope; everyone else is locked to their own affiliate.
    const affFilter = user.isOrgWide
      ? (req.query.affiliate_id || null)
      : (user.affiliateId || null);
    let snapshotRows = SNAPSHOT_ROWS.filter(r => qualifyingMomIds.has(r.mom_id));
    if (affFilter) {
      snapshotRows = snapshotRows.filter(r => r.affiliate_id === affFilter);
    }

    // ── Step 3: apply exclusion rule ─────────────────────────────────────────
    // Completed moms with no intake welfare status → exclude (nothing to validate)
    // Active moms with no intake welfare status → include, flagged as intake_missing
    snapshotRows = snapshotRows.filter(r => {
      const pairing  = qualifyingPairings[r.mom_id];
      const isActive = pairing && pairing.pairing_status === 'paired';
      const hasIntake = !!r.active_child_welfare_involvement;
      if (!isActive && !hasIntake) return false;
      return true;
    });

    if (snapshotRows.length === 0) return res.json([]);

    // ── Step 4: enrichment queries against Trellis V1 ────────────────────────
    const momIds      = [...new Set(snapshotRows.map(r => r.mom_id).filter(Boolean))];
    const affiliateIds = [...new Set(snapshotRows.map(r => r.affiliate_id).filter(Boolean))];
    const childIds    = [...new Set(snapshotRows.map(r => r.child_id).filter(Boolean))];

    const [momsResult, affiliatesResult, childrenResult] = await Promise.all([
      momIds.length > 0
        ? pool.query(
            `SELECT m."id", m."first_name", m."last_name", m."status"::text AS status, m."created_at",
                    u."firstName" AS coord_first, u."lastName" AS coord_last
             FROM "Mom" m
             LEFT JOIN "User" u ON u."id" = m."assigned_user_id" AND u."deleted_at" = 0
             WHERE m."id" = ANY($1)`,
            [momIds]
          ).catch(err => { console.error('[child-welfare] mom query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),

      affiliateIds.length > 0
        ? pool.query(
            `SELECT a."id", a."name" FROM "Affiliate" a WHERE a."id" = ANY($1)`,
            [affiliateIds]
          ).catch(err => { console.error('[child-welfare] affiliate query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),

      childIds.length > 0
        ? pool.query(
            `SELECT c."id", c."active_child_welfare_involvement"::text AS latest_welfare_status
             FROM "Child" c WHERE c."id" = ANY($1) AND c."deleted_at" = 0`,
            [childIds]
          ).catch(err => { console.error('[child-welfare] child query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),
    ]);

    const momMap      = Object.fromEntries(momsResult.rows.map(r => [r.id, r]));
    const affiliateMap = Object.fromEntries(affiliatesResult.rows.map(r => [r.id, r]));
    const childMap    = Object.fromEntries(childrenResult.rows.map(r => [r.id, r]));

    // ── Step 5: build result rows ─────────────────────────────────────────────
    const result = snapshotRows.map(cs => {
      const mom     = momMap[cs.mom_id]           || {};
      const aff     = affiliateMap[cs.affiliate_id] || {};
      const child   = childMap[cs.child_id]       || {};
      const pairing = qualifyingPairings[cs.mom_id] || {};
      const isActive = pairing.pairing_status === 'paired';
      const hasIntake = !!cs.active_child_welfare_involvement;

      return {
        snapshot_id:           cs.id,
        child_id:              cs.child_id,
        mom_id:                cs.mom_id,
        affiliate_id:          cs.affiliate_id,
        affiliate_name:        aff.name || '',
        mom_name:              mom.first_name && mom.last_name
                                 ? `${mom.first_name} ${mom.last_name}`
                                 : '',
        coordinator_name:      mom.coord_first
                                 ? `${mom.coord_first} ${mom.coord_last || ''}`.trim()
                                 : '',
        child_name:            cs.first_name ? cs.first_name.trim() : '',
        birthdate:             cs.birthdate || '',
        intake_date:           mom.created_at || '',
        intake_welfare_status: cs.active_child_welfare_involvement || '',
        latest_welfare_status: child.latest_welfare_status || cs.active_child_welfare_involvement || '',
        record_updated:        cs.child_updated_at || '',
        updated_by:            cs.changed_by_name || '',
        mom_status:            mom.status || '',
        pairing_id:            pairing.pairing_id || '',
        pairing_status:        pairing.pairing_status || '',
        complete_reason:       pairing.complete_reason || '',
        advocacy_type:         pairing.advocacy_type || '',
        intake_missing:        isActive && !hasIntake,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[child-welfare] error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load child welfare data.' });
  }
});

module.exports = router;
