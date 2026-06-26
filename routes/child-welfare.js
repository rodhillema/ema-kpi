/* ============================================================
   Child Welfare Status Review — API
   GET /api/child-welfare
   HQ admin only (administrator role or org-wide whitelist).

   Data sources:
   - ChildSnapshot: loaded from data/child-snapshot.json
     (Supabase export; not in Trellis V1 DB)
   - Mom name, status, created_at: Trellis V1 Mom table
   - Affiliate name: Trellis V1 Affiliate table
   - Track status: Trellis V1 Pairing table
   - Latest welfare status: ChildSnapshot only for now
     (live Child record join is a future open item)
   ============================================================ */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const pool     = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole);

// Load snapshot data once at startup
const SNAPSHOT_PATH = path.join(__dirname, '../data/child-snapshot.json');
let SNAPSHOT_ROWS = [];
try {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8').replace(/^﻿/, ''); // strip UTF-8 BOM
  SNAPSHOT_ROWS = JSON.parse(raw);
  console.log(`[child-welfare] loaded ${SNAPSHOT_ROWS.length} ChildSnapshot rows from JSON`);
} catch (err) {
  console.error('[child-welfare] failed to load child-snapshot.json:', err.message);
}

router.get('/', async (req, res) => {
  const user = req.session.user;

  // HQ admin only
  if (user.role !== 'administrator' && !user.isOrgWide) {
    return res.status(403).json({ error: 'Child Welfare Status Review is restricted to HQ administrators.' });
  }

  try {
    // Filter snapshot rows by affiliate if requested
    const affFilter = req.query.affiliate_id || null;
    const snapshotRows = affFilter
      ? SNAPSHOT_ROWS.filter(r => r.affiliate_id === affFilter)
      : SNAPSHOT_ROWS;

    if (snapshotRows.length === 0) {
      return res.json([]);
    }

    // Collect unique mom_ids and affiliate_ids for Trellis V1 lookups
    const momIds       = [...new Set(snapshotRows.map(r => r.mom_id).filter(Boolean))];
    const affiliateIds = [...new Set(snapshotRows.map(r => r.affiliate_id).filter(Boolean))];

    // Collect unique child_ids for live Child lookup
    const childIds = [...new Set(snapshotRows.map(r => r.child_id).filter(Boolean))];

    // Parallel queries against Trellis V1 — each degraded gracefully on failure
    const [momsResult, affiliatesResult, pairingsResult, childrenResult] = await Promise.all([
      // Mom: name, status, created_at (intake date)
      momIds.length > 0
        ? pool.query(
            `SELECT m."id", m."first_name", m."last_name", m."status"::text AS status, m."created_at"
             FROM "Mom" m
             WHERE m."id" = ANY($1) AND m."deleted_at" = 0`,
            [momIds]
          ).catch(err => { console.error('[child-welfare] mom query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),

      // Affiliate: name
      affiliateIds.length > 0
        ? pool.query(
            `SELECT a."id", a."name" FROM "Affiliate" a WHERE a."id" = ANY($1)`,
            [affiliateIds]
          ).catch(err => { console.error('[child-welfare] affiliate query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),

      // Pairing: most-recent per mom for track status
      momIds.length > 0
        ? pool.query(
            `SELECT DISTINCT ON (p."momId")
               p."momId"                              AS mom_id,
               p."id"                                 AS pairing_id,
               p."status"::text                       AS pairing_status,
               p."complete_reason_sub_status"::text   AS complete_reason
             FROM "Pairing" p
             WHERE p."momId" = ANY($1)
               AND p."deleted_at" = 0
               AND (p."status"::text = 'paired'
                 OR p."status"::text = 'pairing_complete'
                 OR p."complete_reason_sub_status" IS NOT NULL)
             ORDER BY p."momId", p."createdAt" DESC NULLS LAST`,
            [momIds]
          ).catch(err => { console.error('[child-welfare] pairing query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),

      // Child: live latest welfare status from Trellis V1
      childIds.length > 0
        ? pool.query(
            `SELECT c."id", c."active_child_welfare_involvement"::text AS latest_welfare_status
             FROM "Child" c
             WHERE c."id" = ANY($1) AND c."deleted_at" = 0`,
            [childIds]
          ).catch(err => { console.error('[child-welfare] child query failed:', err.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] }),
    ]);

    // Index lookup maps
    const momMap       = Object.fromEntries(momsResult.rows.map(r => [r.id, r]));
    const affiliateMap = Object.fromEntries(affiliatesResult.rows.map(r => [r.id, r]));
    const pairingMap   = Object.fromEntries(pairingsResult.rows.map(r => [r.mom_id, r]));
    const childMap     = Object.fromEntries(childrenResult.rows.map(r => [r.id, r]));

    // Build response rows
    const result = snapshotRows.map(cs => {
      const mom      = momMap[cs.mom_id]          || {};
      const aff      = affiliateMap[cs.affiliate_id] || {};
      const pairing  = pairingMap[cs.mom_id]      || {};
      const child    = childMap[cs.child_id]       || {};

      return {
        snapshot_id:            cs.id,
        child_id:               cs.child_id,
        mom_id:                 cs.mom_id,
        affiliate_id:           cs.affiliate_id,
        affiliate_name:         aff.name || '',
        mom_name:               mom.first_name && mom.last_name
                                  ? `${mom.first_name} ${mom.last_name}`
                                  : '',
        child_name:             cs.first_name ? cs.first_name.trim() : '',
        birthdate:              cs.birthdate || '',
        intake_date:            mom.created_at || '',
        intake_welfare_status:  cs.active_child_welfare_involvement || '',
        intake_goal:            cs.family_preservation_goal || '',
        // Latest welfare status: live from Trellis V1 Child table; falls back to snapshot
        latest_welfare_status:  child.latest_welfare_status || cs.active_child_welfare_involvement || '',
        record_updated:         cs.child_updated_at || '',
        updated_by:             cs.changed_by_name || '',
        mom_status:             mom.status || '',
        pairing_id:             pairing.pairing_id || '',
        pairing_status:         pairing.pairing_status || '',
        complete_reason:        pairing.complete_reason || '',
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[child-welfare] error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load child welfare data.' });
  }
});

module.exports = router;
