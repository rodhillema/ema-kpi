/* ============================================================
   /api/report-data — KPI Report Data Endpoint
   Returns the full data envelope for all 5 dashboard tabs.
   Scoped by affiliate for coordinator/staff_advocate roles.
   Admin sees all; optional ?affiliate_id= param to filter.
   ============================================================ */

const express = require('express');
const router = express.Router();
const pool = require('../db');

// Q1 2026 reporting window
const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-03-31';
const PERIOD_LABEL = 'Q1 2026';

// Roles that see all affiliates
// Only administrator is org-wide by default. Supervisor is affiliate-scoped.
// Champions are org-wide only if they have no affiliateId (checked at line 36).
const ORG_WIDE_ROLES = ['administrator'];

// Required sessions per track for fidelity
const REQUIRED_SESSIONS = {
  'Nurturing Parenting Program': 10,
  'El programa de Crianza con cariño NPP': 10,
  'Empowered Parenting': 8,
  'Crianza empoderada EP': 8,
  'Roadmap to Resilience': 4,
  'Hoja de ruta hacia la resiliencia RR': 4,
};

router.get('/', async (req, res) => {
  try {
    const { role, affiliateId } = req.session.user;

    // Determine affiliate filter
    // Champions with no affiliateId are org-wide (like admin)
    const isOrgWideRole = ORG_WIDE_ROLES.includes(role) || (role === 'champion' && !affiliateId);
    let affiliateFilter = affiliateId;
    const excludeAffiliateId = req.query.exclude_affiliate_id || null;
    if (isOrgWideRole && req.query.affiliate_id) {
      affiliateFilter = req.query.affiliate_id;
    }
    const isOrgWide = isOrgWideRole && !req.query.affiliate_id && !excludeAffiliateId;

    // Build WHERE clause for affiliate scoping
    let affWhere, affWhereUser, affParams;
    if (excludeAffiliateId && isOrgWideRole) {
      // "All except X" mode
      affWhere = `AND m."affiliate_id" != $1`;
      affWhereUser = `AND u."affiliateId" != $1`;
      affParams = [excludeAffiliateId];
    } else if (isOrgWide) {
      affWhere = '';
      affWhereUser = '';
      affParams = [];
    } else {
      affWhere = `AND m."affiliate_id" = $1`;
      affWhereUser = `AND u."affiliateId" = $1`;
      affParams = [affiliateFilter];
    }

    // ─── Intake Date CTE (reusable SQL fragment) ────────────
    // Derived from AuditLog per intake_date_methodology.md
    // Excludes PS-migrated moms (Nov 30 / Dec 17 2025 batches)
    const INTAKE_CTE = `
      first_engaged AS (
        SELECT data->>'id' AS mom_id, MIN(created_at) AS coordinator_engaged_date
        FROM "AuditLog"
        WHERE "table" = 'Mom' AND action = 'Update'
          AND data->>'prospect_status' = 'engaged_in_program'
        GROUP BY data->>'id'
      ),
      organic_only AS (
        SELECT * FROM first_engaged
        WHERE DATE_TRUNC('day', coordinator_engaged_date) NOT IN ('2025-11-30', '2025-12-17')
      ),
      first_self_complete AS (
        SELECT
          a.data->>'id' AS mom_id,
          MIN(a.created_at) AS self_complete_date
        FROM "AuditLog" a
        JOIN organic_only oo ON oo.mom_id = a.data->>'id'
        WHERE a."table" = 'Mom' AND a.action = 'Update'
          AND a.data->>'prospect_status' = 'engaged_in_program'
          AND (a.data->>'updated_by_name' IS NULL OR a.data->>'updated_by_name' = '')
          AND a.created_at > oo.coordinator_engaged_date
          AND EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/New_York') NOT IN (5, 6)
        GROUP BY a.data->>'id'
      ),
      intake_dates AS (
        SELECT oo.mom_id,
          CASE WHEN fsc.self_complete_date IS NOT NULL THEN fsc.self_complete_date
               ELSE oo.coordinator_engaged_date END AS best_intake_date,
          CASE WHEN fsc.self_complete_date IS NOT NULL THEN 'link_based'
               ELSE 'coordinator_led' END AS intake_method
        FROM organic_only oo
        LEFT JOIN first_self_complete fsc ON fsc.mom_id = oo.mom_id
      )`;

    // ─── Run all independent queries in parallel ────────────

    const [
      momStatusCounts,
      activeInTrack,
      membershipCommunity,
      sessionsInPeriod,
      familiesServed,
      advocateCount,
      childrenCount,
      avgChildren,
      momsNoChildren,
      fssScores,
      affiliateComparison,
      stalledMoms,
      stallBuckets,
      stallByAffiliate,
      fwaCurrency,
      fwaCurrencyByAffiliate,
      trackCompletions,
      trackCompletionsExpanded,
      completionsByFormat,
      completionsByTrack,
      learningProgressByTrack,
      avgSessionsPerTrack,
      sessionDepth,
      sessionsByTrack,
      referralSources,
      advocacyTypeSplit,
      advocatePipeline,
      advocateSubStatus,
      childWelfareInvolvement,
      familiesServedExpanded,
      advocateQ1Activity,
      kpi1,
      kpi1Excluded,
      kpi2,
      kpi3,
      intakeData,
      psMigrated,
      affiliates,
      affNameResult,
    ] = await Promise.all([

      // ─── TAB 1: KPIs & Status ───────────────────────────────

      pool.query(`
        SELECT m."status"::text AS status, COUNT(*)::int AS count
        FROM "Mom" m
        WHERE m."deleted_at" = 0 ${affWhere}
        GROUP BY m."status"::text
        ORDER BY 1
      `, affParams),

      // Active in track (paired pairings)
      pool.query(`
        SELECT COUNT(DISTINCT p."momId")::int AS count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // Membership community: active mom + no active pairing
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM "Mom" m
        WHERE m."deleted_at" = 0
          AND m."status"::text = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM "Pairing" p
            WHERE p."momId" = m."id"
              AND p."deleted_at" = 0
              AND p."status"::text = 'paired'
          )
          ${affWhere}
      `, affParams),

      // Sessions held in period
      pool.query(`
        SELECT s."status"::text AS status, COUNT(*)::int AS count
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE s."deleted_at" = 0
          AND s."date_start" >= '${PERIOD_START}'
          AND s."date_start" <= '${PERIOD_END} 23:59:59'
          ${affWhere}
        GROUP BY s."status"::text
        ORDER BY 1
      `, affParams),

      // ─── TAB 2: End of Q1 Snapshot ──────────────────────────

      // Families served (active-during-period logic)
      pool.query(`
        SELECT COUNT(DISTINCT m."id")::int AS count
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
      `, affParams),

      // Active advocates (distinct advocate users with active pairings)
      pool.query(`
        SELECT COUNT(DISTINCT p."advocateUserId")::int AS count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // Children count (children of active moms)
      pool.query(`
        SELECT COUNT(c."id")::int AS total,
               COUNT(DISTINCT c."mom_id")::int AS moms_with_children
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        WHERE c."deleted_at" = 0
          AND m."deleted_at" = 0
          AND m."status"::text = 'active'
          ${affWhere}
      `, affParams),

      // Average children per mom (for proxy calculation)
      pool.query(`
        SELECT ROUND(AVG(child_count)::numeric, 2)::float AS avg_children
        FROM (
          SELECT c."mom_id", COUNT(*)::int AS child_count
          FROM "Child" c
          JOIN "Mom" m ON m."id" = c."mom_id"
          WHERE c."deleted_at" = 0 AND m."deleted_at" = 0 AND m."status"::text = 'active'
            ${affWhere}
          GROUP BY c."mom_id"
        ) sub
      `, affParams),

      // Moms with no child records
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM "Mom" m
        WHERE m."deleted_at" = 0
          AND m."status"::text = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM "Child" c WHERE c."mom_id" = m."id" AND c."deleted_at" = 0
          )
          ${affWhere}
      `, affParams),

      // ─── TAB 3: FSS Deep Dive ───────────────────────────────

      // Assessment results with construct-level scores
      // Get all completed assessment results for moms in scope
      pool.query(`
        SELECT
          ac."name" AS domain,
          ac."order" AS domain_order,
          ar."type"::text AS assessment_type,
          COUNT(DISTINCT ar."momId")::int AS mom_count,
          ROUND(AVG(arqr."intResponse")::numeric, 2)::float AS avg_score
        FROM "AssessmentResult" ar
        JOIN "AssessmentResultQuestionResponse" arqr ON arqr."assessmentResultId" = ar."id"
        JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId"
        JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId"
        JOIN "Mom" m ON m."id" = ar."momId"
        WHERE ar."deleted_at" = 0
          AND arqr."deleted_at" = 0
          AND aq."deleted_at" = 0
          AND ac."deleted_at" = 0
          AND m."deleted_at" = 0
          AND arqr."intResponse" IS NOT NULL
          ${affWhere}
        GROUP BY ac."name", ac."order", ar."type"::text
        ORDER BY ac."order", ar."type"::text
      `, affParams),

      // ─── TAB 4: Affiliate Comparison ────────────────────────

      isOrgWide ? pool.query(`
        SELECT
          a."id" AS affiliate_id,
          a."name" AS affiliate_name,
          COUNT(DISTINCT CASE WHEN m."status"::text = 'active' THEN m."id" END)::int AS active_moms,
          COUNT(DISTINCT CASE WHEN p."status"::text = 'paired' THEN p."advocateUserId" END)::int AS active_advocates,
          COUNT(DISTINCT CASE WHEN p."status"::text = 'paired' THEN p."id" END)::int AS active_pairings
        FROM "Affiliate" a
        LEFT JOIN "Mom" m ON m."affiliate_id" = a."id" AND m."deleted_at" = 0
        LEFT JOIN "Pairing" p ON p."momId" = m."id" AND p."deleted_at" = 0
        WHERE a."deleted_at" = 0
        GROUP BY a."id", a."name"
        ORDER BY a."name"
      `) : Promise.resolve({ rows: [] }),

      // ─── TAB 5: Track Oversight ─────────────────────────────

      // Stalled moms: active pairing, last held session > 14 days ago
      pool.query(`
        SELECT
          m."id" AS mom_id,
          m."first_name",
          m."last_name",
          p."id" AS pairing_id,
          t."title" AS track_title,
          u."firstName" AS advocate_first,
          u."lastName" AS advocate_last,
          last_held."last_held_date",
          EXTRACT(DAY FROM NOW() - last_held."last_held_date")::int AS days_since_held
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        LEFT JOIN "User" u ON u."id" = p."advocateUserId"
        LEFT JOIN LATERAL (
          SELECT MAX(s."date_start") AS last_held_date
          FROM "Session" s
          WHERE s."pairing_id" = p."id"
            AND s."deleted_at" = 0
            AND s."status"::text = 'Held'
        ) last_held ON true
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          AND (last_held."last_held_date" IS NULL OR last_held."last_held_date" < NOW() - INTERVAL '14 days')
          ${affWhere}
        ORDER BY last_held."last_held_date" ASC NULLS FIRST
      `, affParams),

      // ─── NEW: Stall Buckets (4-card summary) ────────────────

      pool.query(`
        SELECT
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 < 14
          THEN 1 ELSE 0 END)::int AS progressing,
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 >= 14
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 <= 20
          THEN 1 ELSE 0 END)::int AS stalled_14_20,
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 > 20
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 <= 30
          THEN 1 ELSE 0 END)::int AS stalled_21_30,
          SUM(CASE WHEN last_held."last_held_date" IS NULL
              OR EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 > 30
          THEN 1 ELSE 0 END)::int AS stalled_30_plus
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN LATERAL (
          SELECT MAX(s."date_start") AS last_held_date
          FROM "Session" s
          WHERE s."pairing_id" = p."id"
            AND s."deleted_at" = 0
            AND s."status"::text = 'Held'
        ) last_held ON true
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // ─── NEW: Stall by Affiliate Table ──────────────────────

      isOrgWide ? pool.query(`
        SELECT
          a."name" AS affiliate_name,
          COUNT(DISTINCT p."id")::int AS active_in_track,
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 < 14
          THEN 1 ELSE 0 END)::int AS progressing,
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 >= 14
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 <= 20
          THEN 1 ELSE 0 END)::int AS stalled_14_20,
          SUM(CASE WHEN last_held."last_held_date" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 > 20
              AND EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 <= 30
          THEN 1 ELSE 0 END)::int AS stalled_21_30,
          SUM(CASE WHEN last_held."last_held_date" IS NULL
              OR EXTRACT(EPOCH FROM NOW() - last_held."last_held_date") / 86400 > 30
          THEN 1 ELSE 0 END)::int AS stalled_30_plus
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        JOIN "Affiliate" a ON a."id" = m."affiliate_id"
        LEFT JOIN LATERAL (
          SELECT MAX(s."date_start") AS last_held_date
          FROM "Session" s
          WHERE s."pairing_id" = p."id"
            AND s."deleted_at" = 0
            AND s."status"::text = 'Held'
        ) last_held ON true
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          AND a."deleted_at" = 0
        GROUP BY a."name"
        ORDER BY a."name"
      `) : Promise.resolve({ rows: [] }),

      // ─── NEW: FWA Currency ──────────────────────────────────

      pool.query(`
        SELECT
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 <= 90
          THEN 1 ELSE 0 END)::int AS current_0_90,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 > 90
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 <= 180
          THEN 1 ELSE 0 END)::int AS overdue_91_180,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 > 180
          THEN 1 ELSE 0 END)::int AS critical_180_plus,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NULL
          THEN 1 ELSE 0 END)::int AS no_fwa
        FROM "Mom" m
        LEFT JOIN LATERAL (
          SELECT GREATEST(MAX(ar."completedAt"), MAX(ar."lastSaved")) AS last_fwa
          FROM "AssessmentResult" ar
          WHERE ar."momId" = m."id"
            AND ar."deleted_at" = 0
        ) latest_fwa ON true
        WHERE m."deleted_at" = 0
          AND m."status"::text = 'active'
          ${affWhere}
      `, affParams),

      // FWA currency by affiliate (for bar chart)
      isOrgWide ? pool.query(`
        SELECT
          a."name" AS affiliate_name,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 <= 90
          THEN 1 ELSE 0 END)::int AS current_0_90,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 > 90
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 <= 180
          THEN 1 ELSE 0 END)::int AS overdue_91_180,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NOT NULL
              AND EXTRACT(EPOCH FROM NOW() - latest_fwa."last_fwa") / 86400 > 180
          THEN 1 ELSE 0 END)::int AS critical_180_plus,
          SUM(CASE WHEN latest_fwa."last_fwa" IS NULL
          THEN 1 ELSE 0 END)::int AS no_fwa
        FROM "Mom" m
        JOIN "Affiliate" a ON a."id" = m."affiliate_id"
        LEFT JOIN LATERAL (
          SELECT GREATEST(MAX(ar."completedAt"), MAX(ar."lastSaved")) AS last_fwa
          FROM "AssessmentResult" ar
          WHERE ar."momId" = m."id"
            AND ar."deleted_at" = 0
        ) latest_fwa ON true
        WHERE m."deleted_at" = 0
          AND m."status"::text = 'active'
          AND a."deleted_at" = 0
        GROUP BY a."name"
        ORDER BY a."name"
      `) : Promise.resolve({ rows: [] }),

      // Track completions in period
      pool.query(`
        SELECT
          t."title" AS track_title,
          p."complete_reason_sub_status"::text AS completion_type,
          p."incomplete_reason_sub_status"::text AS incomplete_reason,
          COUNT(*)::int AS count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'pairing_complete'
          AND p."completed_on" >= '${PERIOD_START}'
          AND p."completed_on" <= '${PERIOD_END} 23:59:59'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY t."title", p."complete_reason_sub_status"::text, p."incomplete_reason_sub_status"::text
        ORDER BY t."title", 2, 3
      `, affParams),

      // ─── NEW: Track Completions Expanded ────────────────────

      pool.query(`
        SELECT
          SUM(CASE WHEN p."complete_reason_sub_status" IS NOT NULL
          THEN 1 ELSE 0 END)::int AS total_completions,
          SUM(CASE WHEN p."incomplete_reason_sub_status" IS NOT NULL
          THEN 1 ELSE 0 END)::int AS total_incompletes,
          SUM(CASE WHEN p."complete_reason_sub_status"::text = 'completed_full_track'
          THEN 1 ELSE 0 END)::int AS completed_full_track,
          SUM(CASE WHEN p."complete_reason_sub_status"::text = 'completed_without_post_assessment'
          THEN 1 ELSE 0 END)::int AS completed_without_post_assessment,
          SUM(CASE WHEN p."complete_reason_sub_status"::text = 'completed_without_support_sessions'
          THEN 1 ELSE 0 END)::int AS completed_without_support_sessions,
          SUM(CASE WHEN p."incomplete_reason_sub_status"::text = 'achieved_outcomes'
          THEN 1 ELSE 0 END)::int AS incomplete_achieved_outcomes,
          SUM(CASE WHEN p."incomplete_reason_sub_status"::text = 'extended_wait'
          THEN 1 ELSE 0 END)::int AS incomplete_extended_wait,
          SUM(CASE WHEN p."incomplete_reason_sub_status"::text = 'no_advocate'
          THEN 1 ELSE 0 END)::int AS incomplete_no_advocate,
          SUM(CASE WHEN p."incomplete_reason_sub_status"::text = 'priorities_shifted'
          THEN 1 ELSE 0 END)::int AS incomplete_priorities_shifted
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'pairing_complete'
          AND p."completed_on" >= '${PERIOD_START}'
          AND p."completed_on" <= '${PERIOD_END} 23:59:59'
          AND m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // ─── Completions by delivery format (1:1 vs group) ─────
      // Only counts actual completions (not incompletes) — should add up to total_completions
      pool.query(`
        SELECT p."advocacy_type"::text AS advocacy_type, COUNT(*)::int AS count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'pairing_complete'
          AND p."complete_reason_sub_status" IS NOT NULL
          AND p."completed_on" >= '${PERIOD_START}'
          AND p."completed_on" <= '${PERIOD_END} 23:59:59'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY p."advocacy_type"::text
      `, affParams),

      // ─── Completions by track + language ────────────────────
      pool.query(`
        SELECT t."title" AS track_title, t."language_type"::text AS language,
          COUNT(*)::int AS total_closed,
          SUM(CASE WHEN p."complete_reason_sub_status" IS NOT NULL THEN 1 ELSE 0 END)::int AS completed,
          SUM(CASE WHEN p."incomplete_reason_sub_status" IS NOT NULL THEN 1 ELSE 0 END)::int AS incomplete
        FROM "Pairing" p
        JOIN "Track" t ON t."id" = p."trackId"
        JOIN "Mom" m ON m."id" = p."momId"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'pairing_complete'
          AND p."completed_on" >= '${PERIOD_START}'
          AND p."completed_on" <= '${PERIOD_END} 23:59:59'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY t."title", t."language_type"::text
        ORDER BY total_closed DESC
      `, affParams),

      // ─── Learning Progress by Track (pre/post improvement per track group) ──
      pool.query(`
        WITH completions AS (
          SELECT p."id" AS pairing_id, p."momId", t."title" AS track_title
          FROM "Pairing" p
          JOIN "Track" t ON t."id" = p."trackId"
          JOIN "Mom" m ON m."id" = p."momId"
          WHERE p."deleted_at" = 0 AND p."status"::text = 'pairing_complete'
            AND p."complete_reason_sub_status" IS NOT NULL
            AND p."completed_on" >= '${PERIOD_START}' AND p."completed_on" <= '${PERIOD_END} 23:59:59'
            AND m."deleted_at" = 0 ${affWhere}
        ),
        with_scores AS (
          SELECT c.pairing_id, c.track_title,
            (SELECT AVG(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
             WHERE ar."momId" = c."momId" AND ar."type"::text = 'pre' AND ar."deleted_at" = 0
               AND arqr."deleted_at" = 0 AND arqr."intResponse" IS NOT NULL) AS pre_avg,
            (SELECT AVG(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
             WHERE ar."momId" = c."momId" AND ar."type"::text = 'post' AND ar."deleted_at" = 0
               AND arqr."deleted_at" = 0 AND arqr."intResponse" IS NOT NULL) AS post_avg
          FROM completions c
        )
        SELECT
          CASE
            WHEN track_title ILIKE '%nurturing%' OR track_title ILIKE '%crianza con%' THEN 'NPP'
            WHEN track_title ILIKE '%empowered%' OR track_title ILIKE '%crianza empoderada%' THEN 'EP'
            WHEN track_title ILIKE '%roadmap%' OR track_title ILIKE '%ruta%' THEN 'RR'
            ELSE 'Other'
          END AS track_group,
          COUNT(DISTINCT pairing_id)::int AS total_completions,
          COUNT(DISTINCT CASE WHEN pre_avg IS NOT NULL AND post_avg IS NOT NULL THEN pairing_id END)::int AS valid_pairs,
          COUNT(DISTINCT CASE WHEN pre_avg IS NOT NULL AND post_avg IS NOT NULL AND post_avg > pre_avg THEN pairing_id END)::int AS improved
        FROM with_scores
        GROUP BY 1 ORDER BY 1
      `, affParams),

      // ─── Average Sessions per Completed Track ──────────────
      pool.query(`
        SELECT
          CASE
            WHEN t."title" ILIKE '%nurturing%' OR t."title" ILIKE '%crianza con%' THEN 'NPP'
            WHEN t."title" ILIKE '%empowered%' OR t."title" ILIKE '%crianza empoderada%' THEN 'EP'
            WHEN t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%ruta%' THEN 'RR'
            ELSE 'Other'
          END AS track_group,
          COUNT(DISTINCT p."id")::int AS completed_tracks,
          ROUND(AVG(track_sess.cnt)::numeric, 1)::float AS avg_track_sessions,
          ROUND(AVG(support_sess.cnt)::numeric, 1)::float AS avg_support_sessions
        FROM "Pairing" p
        JOIN "Track" t ON t."id" = p."trackId"
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS cnt FROM "Session" s
          WHERE s."pairing_id" = p."id" AND s."deleted_at" = 0
            AND s."status"::text = 'Held' AND s."session_type"::text = 'Track_Session'
        ) track_sess ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS cnt FROM "Session" s
          WHERE s."pairing_id" = p."id" AND s."deleted_at" = 0
            AND s."status"::text = 'Held' AND s."session_type"::text = 'Support_Session'
        ) support_sess ON true
        WHERE p."deleted_at" = 0 AND p."status"::text = 'pairing_complete'
          AND p."complete_reason_sub_status" IS NOT NULL
          AND p."completed_on" >= '${PERIOD_START}' AND p."completed_on" <= '${PERIOD_END} 23:59:59'
          AND m."deleted_at" = 0 ${affWhere}
        GROUP BY 1 ORDER BY 1
      `, affParams),

      // Session depth per active pairing (for fidelity check)
      pool.query(`
        SELECT
          p."id" AS pairing_id,
          m."first_name",
          m."last_name",
          t."title" AS track_title,
          COUNT(CASE WHEN s."status"::text = 'Held' THEN 1 END)::int AS held_count,
          COUNT(CASE WHEN s."status"::text = 'Planned' THEN 1 END)::int AS planned_count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        LEFT JOIN "Session" s ON s."pairing_id" = p."id" AND s."deleted_at" = 0
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY p."id", m."first_name", m."last_name", t."title"
        ORDER BY held_count ASC
      `, affParams),

      // ─── NEW: Session Counts by Track ───────────────────────

      pool.query(`
        SELECT
          t."title" AS track_title,
          COUNT(DISTINCT p."momId")::int AS moms_active,
          ROUND(
            AVG(pairing_sessions."track_session_count")::numeric, 2
          )::float AS avg_track_sessions,
          ROUND(
            AVG(pairing_sessions."support_session_count")::numeric, 2
          )::float AS avg_support_sessions
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        LEFT JOIN LATERAL (
          SELECT
            SUM(CASE WHEN s."status"::text = 'Held' AND s."session_type"::text = 'Track_Session'
            THEN 1 ELSE 0 END)::int AS track_session_count,
            SUM(CASE WHEN s."status"::text = 'Held' AND s."session_type"::text = 'Support_Session'
            THEN 1 ELSE 0 END)::int AS support_session_count
          FROM "Session" s
          WHERE s."pairing_id" = p."id"
            AND s."deleted_at" = 0
        ) pairing_sessions ON true
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY t."title"
        ORDER BY t."title"
      `, affParams),

      // ─── NEW: Referral Sources ──────────────────────────────

      pool.query(`
        SELECT
          COALESCE(a."name", 'Unknown / Not Recorded') AS referral_source,
          COUNT(*)::int AS referrals_received,
          SUM(CASE WHEN m."prospect_status"::text = 'engaged_in_program' THEN 1 ELSE 0 END)::int AS intakes_completed,
          SUM(CASE WHEN m."prospect_status"::text = 'did_not_engage_in_program' THEN 1 ELSE 0 END)::int AS did_not_engage,
          SUM(CASE WHEN m."prospect_status"::text IN ('prospect', 'prospect_intake_scheduled') THEN 1 ELSE 0 END)::int AS pending
        FROM "Mom" m
        LEFT JOIN "Agency" a ON a."id" = m."agency_id"
        WHERE m."deleted_at" = 0
          AND m."created_at" >= '${PERIOD_START}'
          AND m."created_at" <= '${PERIOD_END} 23:59:59'
          ${affWhere}
        GROUP BY COALESCE(a."name", 'Unknown / Not Recorded')
        ORDER BY referrals_received DESC
      `, affParams),

      // ─── NEW: Advocacy Type Split ───────────────────────────

      pool.query(`
        SELECT
          p."advocacy_type"::text AS advocacy_type,
          COUNT(DISTINCT p."id")::int AS active_pairings,
          COUNT(DISTINCT p."advocateUserId")::int AS distinct_advocates,
          COUNT(DISTINCT s."id")::int AS session_count
        FROM "Pairing" p
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Session" s
          ON s."pairing_id" = p."id"
          AND s."deleted_at" = 0
          AND s."status"::text = 'Held'
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY p."advocacy_type"::text
        ORDER BY p."advocacy_type"::text
      `, affParams),

      // ─── NEW: Advocate Pipeline ─────────────────────────────

      pool.query(`
        SELECT
          u."advocate_status"::text AS advocate_status,
          COUNT(*)::int AS count
        FROM "User" u
        WHERE u."deleted_at" = 0
          ${affWhereUser}
        GROUP BY u."advocate_status"::text
        ORDER BY u."advocate_status"::text
      `, affParams),

      pool.query(`
        SELECT
          u."advocate_sub_status"::text AS advocate_sub_status,
          COUNT(*)::int AS count
        FROM "User" u
        WHERE u."deleted_at" = 0
          AND u."advocate_sub_status" IS NOT NULL
          ${affWhereUser}
        GROUP BY u."advocate_sub_status"::text
        ORDER BY u."advocate_sub_status"::text
      `, affParams),

      // ─── Advocate Q1 Activity (from AuditLog — true event-based) ──
      pool.query(`
        WITH first_sub_transitions AS (
          SELECT data->>'id' AS user_id, data->>'advocate_sub_status' AS sub_status,
            MIN(created_at) AS first_reached
          FROM "AuditLog"
          WHERE "table" = 'User' AND action = 'Update'
            AND data->>'advocate_sub_status' IS NOT NULL
          GROUP BY data->>'id', data->>'advocate_sub_status'
        ),
        q1_subs AS (
          SELECT sub_status, COUNT(DISTINCT user_id)::int AS advocates
          FROM first_sub_transitions
          WHERE first_reached >= '${PERIOD_START}' AND first_reached <= '${PERIOD_END} 23:59:59'
          GROUP BY sub_status
        ),
        first_active AS (
          SELECT data->>'id' AS user_id, MIN(created_at) AS first_date
          FROM "AuditLog"
          WHERE "table" = 'User' AND action = 'Update'
            AND data->>'advocate_status' = 'Active'
          GROUP BY data->>'id'
        ),
        first_inactive AS (
          SELECT data->>'id' AS user_id, MIN(created_at) AS first_date
          FROM "AuditLog"
          WHERE "table" = 'User' AND action = 'Update'
            AND data->>'advocate_status' = 'Inactive'
          GROUP BY data->>'id'
        )
        SELECT
          (SELECT COALESCE(SUM(advocates), 0)::int FROM q1_subs WHERE sub_status IN ('Interested', 'In_Training')) AS applications,
          (SELECT COALESCE(advocates, 0) FROM q1_subs WHERE sub_status = 'In_Training') AS trained,
          (SELECT COALESCE(advocates, 0) FROM q1_subs WHERE sub_status = 'Training_Completed') AS approved,
          (SELECT COUNT(DISTINCT user_id)::int FROM first_active WHERE first_date >= '${PERIOD_START}' AND first_date <= '${PERIOD_END} 23:59:59') AS became_active,
          (SELECT COUNT(DISTINCT user_id)::int FROM first_inactive WHERE first_date >= '${PERIOD_START}' AND first_date <= '${PERIOD_END} 23:59:59') AS became_inactive
      `),

      // ─── NEW: Children with Welfare Involvement ─────────────

      pool.query(`
        SELECT COUNT(c."id")::int AS count
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        WHERE c."deleted_at" = 0
          AND m."deleted_at" = 0
          AND m."status"::text = 'active'
          AND c."active_child_welfare_involvement" IS NOT NULL
          AND c."active_child_welfare_involvement"::text <> ''
          ${affWhere}
      `, affParams),

      // ─── NEW: Families Served Expanded ──────────────────────

      pool.query(`
        WITH ${INTAKE_CTE}
        SELECT
          COUNT(DISTINCT CASE WHEN m."status"::text = 'active'
          THEN m."id" END)::int AS total_active_moms,
          COUNT(DISTINCT CASE WHEN id.best_intake_date >= '${PERIOD_START}'
              AND id.best_intake_date <= '${PERIOD_END} 23:59:59'
          THEN m."id" END)::int AS new_intakes_in_period,
          COUNT(DISTINCT CASE WHEN m."status"::text = 'active'
              AND EXISTS (
                SELECT 1 FROM "Pairing" p2
                WHERE p2."momId" = m."id"
                  AND p2."deleted_at" = 0
                  AND p2."status"::text = 'paired'
              )
          THEN m."id" END)::int AS active_at_end_of_period
        FROM "Mom" m
        LEFT JOIN intake_dates id ON id.mom_id = m."id"
        WHERE m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // ─── KPI Calculations ────────────────────────────────────

      // KPI 1 — Family Preservation Rate (target 85%)
      // Denominator: all children linked to active moms with valid in-window FWA
      // Numerator: ONLY children with Prevention % impact:
      //   - prevented_from_cps_involvement
      //   - prevented_from_foster_care_placement
      // Everything else (prevented_from_permanent_removal, temporary_removal,
      // permanent_removal) is in denominator but NOT numerator.
      // Reference: Family Preservation Impact methodology
      pool.query(`
        WITH moms_with_current_fwa AS (
          SELECT ar."momId"
          FROM "AssessmentResult" ar
          JOIN "Mom" m ON m."id" = ar."momId"
          WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0 AND m."status"::text = 'active'
            ${affWhere}
          GROUP BY ar."momId"
          HAVING EXTRACT(DAY FROM NOW() - GREATEST(MAX(ar."completedAt"), MAX(ar."lastSaved"))) <= 90
        )
        SELECT
          COUNT(c."id")::int AS denominator,
          SUM(CASE WHEN c."family_preservation_impact" IN ('prevented_from_cps_involvement', 'prevented_from_foster_care_placement') THEN 1 ELSE 0 END)::int AS numerator
        FROM "Child" c
        JOIN moms_with_current_fwa f ON f."momId" = c."mom_id"
        WHERE c."deleted_at" = 0
      `, affParams),

      // Count children excluded (active moms with no valid FWA)
      pool.query(`
        SELECT COUNT(c."id")::int AS count
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        WHERE c."deleted_at" = 0 AND m."deleted_at" = 0 AND m."status"::text = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM "AssessmentResult" ar
            WHERE ar."momId" = m."id" AND ar."deleted_at" = 0
            GROUP BY ar."momId"
            HAVING EXTRACT(DAY FROM NOW() - GREATEST(MAX(ar."completedAt"), MAX(ar."lastSaved"))) <= 90
          )
          ${affWhere}
      `, affParams),

      // KPI 2 — FSS Improvement Rate (target 70%)
      // Moms with pre+post assessment where composite improved
      pool.query(`
        WITH mom_scores AS (
          SELECT ar."momId", ar."type"::text AS atype,
            AVG(arqr."intResponse")::numeric(10,2) AS avg_score
          FROM "AssessmentResult" ar
          JOIN "AssessmentResultQuestionResponse" arqr ON arqr."assessmentResultId" = ar."id"
          JOIN "Mom" m ON m."id" = ar."momId"
          WHERE ar."deleted_at" = 0 AND arqr."deleted_at" = 0 AND m."deleted_at" = 0
            AND m."status"::text = 'active'
            AND arqr."intResponse" IS NOT NULL
            ${affWhere}
          GROUP BY ar."momId", ar."type"::text
        ),
        paired AS (
          SELECT pre."momId",
            pre.avg_score AS pre_score,
            post.avg_score AS post_score
          FROM mom_scores pre
          JOIN mom_scores post ON pre."momId" = post."momId" AND post.atype = 'post'
          WHERE pre.atype = 'pre'
        )
        SELECT
          COUNT(*)::int AS denominator,
          SUM(CASE WHEN post_score > pre_score THEN 1 ELSE 0 END)::int AS numerator
        FROM paired
      `, affParams),

      // KPI 3 — Learning Progress (target 70%)
      // Track completions in Q1 with pre/post improvement
      pool.query(`
        WITH completions AS (
          SELECT p."id" AS pairing_id, p."momId", p."trackId"
          FROM "Pairing" p
          JOIN "Mom" m ON m."id" = p."momId"
          WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
            AND p."status"::text = 'pairing_complete'
            AND p."complete_reason_sub_status" IS NOT NULL
            AND p."completed_on" >= '${PERIOD_START}'
            AND p."completed_on" <= '${PERIOD_END} 23:59:59'
            ${affWhere}
        ),
        with_scores AS (
          SELECT c.pairing_id,
            (SELECT AVG(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
             WHERE ar."momId" = c."momId" AND ar."type"::text = 'pre' AND ar."deleted_at" = 0
               AND arqr."deleted_at" = 0 AND arqr."intResponse" IS NOT NULL) AS pre_avg,
            (SELECT AVG(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
             WHERE ar."momId" = c."momId" AND ar."type"::text = 'post' AND ar."deleted_at" = 0
               AND arqr."deleted_at" = 0 AND arqr."intResponse" IS NOT NULL) AS post_avg
          FROM completions c
        )
        SELECT
          COUNT(DISTINCT pairing_id)::int AS total_completions,
          COUNT(DISTINCT CASE WHEN pre_avg IS NOT NULL AND post_avg IS NOT NULL THEN pairing_id END)::int AS with_pre_post,
          COUNT(DISTINCT CASE WHEN pre_avg IS NOT NULL AND post_avg IS NOT NULL AND post_avg > pre_avg THEN pairing_id END)::int AS improved
        FROM with_scores
      `, affParams),

      // ─── Intake Date (derived from AuditLog) ─────────────────

      // Intake date methodology: derived from AuditLog prospect_status = 'engaged_in_program'
      // Excludes PS-migrated moms (Nov 30 / Dec 17 2025 batches)
      // Link-based intakes use first blank updated_by_name row after coordinator's engaged event
      pool.query(`
        WITH first_engaged AS (
          SELECT
            data->>'id' AS mom_id,
            MIN(created_at) AS coordinator_engaged_date
          FROM "AuditLog"
          WHERE "table" = 'Mom'
            AND action = 'Update'
            AND data->>'prospect_status' = 'engaged_in_program'
          GROUP BY data->>'id'
        ),
        organic_only AS (
          SELECT *
          FROM first_engaged
          WHERE DATE_TRUNC('day', coordinator_engaged_date)
            NOT IN ('2025-11-30', '2025-12-17')
        ),
        first_self_complete AS (
          SELECT
            a.data->>'id' AS mom_id,
            MIN(a.created_at) AS self_complete_date
          FROM "AuditLog" a
          JOIN organic_only oo ON oo.mom_id = a.data->>'id'
          WHERE a."table" = 'Mom'
            AND a.action = 'Update'
            AND a.data->>'prospect_status' = 'engaged_in_program'
            AND (a.data->>'updated_by_name' IS NULL OR a.data->>'updated_by_name' = '')
            AND a.created_at > oo.coordinator_engaged_date
            AND EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/New_York') NOT IN (5, 6)
          GROUP BY a.data->>'id'
        ),
        intake_dates AS (
          SELECT
            oo.mom_id,
            CASE
              WHEN fsc.self_complete_date IS NOT NULL THEN fsc.self_complete_date
              ELSE oo.coordinator_engaged_date
            END AS best_intake_date,
            CASE
              WHEN fsc.self_complete_date IS NOT NULL THEN 'link_based'
              ELSE 'coordinator_led'
            END AS intake_method
          FROM organic_only oo
          LEFT JOIN first_self_complete fsc ON fsc.mom_id = oo.mom_id
        )
        SELECT
          COUNT(*)::int AS total_trellis_intakes,
          SUM(CASE WHEN intake_method = 'coordinator_led' THEN 1 ELSE 0 END)::int AS coordinator_led,
          SUM(CASE WHEN intake_method = 'link_based' THEN 1 ELSE 0 END)::int AS link_based,
          SUM(CASE WHEN best_intake_date >= '${PERIOD_START}' AND best_intake_date <= '${PERIOD_END} 23:59:59' THEN 1 ELSE 0 END)::int AS intakes_in_period
        FROM intake_dates id
        JOIN "Mom" m ON m."id" = id.mom_id
        WHERE m."deleted_at" = 0
          ${affWhere}
      `, affParams),

      // Count PS-migrated moms (excluded from intake calculations)
      pool.query(`
        SELECT COUNT(DISTINCT data->>'id')::int AS count
        FROM "AuditLog"
        WHERE "table" = 'Mom'
          AND action = 'Update'
          AND data->>'prospect_status' = 'engaged_in_program'
          AND DATE_TRUNC('day', created_at) IN ('2025-11-30', '2025-12-17')
      `),

      // ─── Affiliate list (for admin slicer) ──────────────────

      isOrgWideRole ? pool.query(`
        SELECT "id", "name" FROM "Affiliate"
        WHERE "deleted_at" = 0
        ORDER BY "name"
      `) : Promise.resolve({ rows: [] }),

      // Look up selected affiliate name (when admin/champion picks a different affiliate)
      (isOrgWideRole && req.query.affiliate_id) ? pool.query(
        `SELECT "name" FROM "Affiliate" WHERE "id" = $1 AND "deleted_at" = 0 LIMIT 1`,
        [req.query.affiliate_id]
      ) : Promise.resolve({ rows: [] }),

    ]);

    // ─── Post-query computations ────────────────────────────

    // Resolve affiliate name from parallel query result
    let affiliateName = req.session.user.affiliateName;
    if (excludeAffiliateId) {
      const exclName = (await pool.query(`SELECT "name" FROM "Affiliate" WHERE "id" = $1 LIMIT 1`, [excludeAffiliateId])).rows[0]?.name || 'Unknown';
      affiliateName = 'All Affiliates except ' + exclName;
    } else if (isOrgWideRole && req.query.affiliate_id) {
      affiliateName = affNameResult.rows[0]?.name || 'Unknown Affiliate';
    }

    // KPI 1 rates
    const kpi1Num = kpi1.rows[0]?.numerator || 0;
    const kpi1Den = kpi1.rows[0]?.denominator || 0;
    const kpi1Rate = kpi1Den > 0 ? Math.round(1000 * kpi1Num / kpi1Den) / 10 : null;

    // KPI 2 rates
    const kpi2Num = kpi2.rows[0]?.numerator || 0;
    const kpi2Den = kpi2.rows[0]?.denominator || 0;
    const kpi2Rate = kpi2Den > 0 ? Math.round(1000 * kpi2Num / kpi2Den) / 10 : null;

    // KPI 3 rates
    const kpi3Total = kpi3.rows[0]?.total_completions || 0;
    const kpi3WithData = kpi3.rows[0]?.with_pre_post || 0;
    const kpi3Improved = kpi3.rows[0]?.improved || 0;
    const kpi3Rate = kpi3WithData > 0 ? Math.round(1000 * kpi3Improved / kpi3WithData) / 10 : null;

    // ─── Build response envelope ────────────────────────────

    res.json({
      meta: {
        period: PERIOD_LABEL,
        period_start: PERIOD_START,
        period_end: PERIOD_END,
        role: role,
        affiliate_id: isOrgWide ? null : affiliateFilter,
        affiliate_name: isOrgWide ? 'All Affiliates' : affiliateName,
        generated_at: new Date().toISOString(),
      },

      // Tab 1: KPIs & Status
      kpis: {
        mom_status_counts: momStatusCounts.rows,
        active_in_track: activeInTrack.rows[0].count,
        membership_community: membershipCommunity.rows[0].count,
        sessions_in_period: sessionsInPeriod.rows,
        kpi1: { rate: kpi1Rate, numerator: kpi1Num, denominator: kpi1Den, excluded: kpi1Excluded.rows[0]?.count || 0, target: 85 },
        kpi2: { rate: kpi2Rate, numerator: kpi2Num, denominator: kpi2Den, target: 70 },
        kpi3: { rate: kpi3Rate, numerator: kpi3Improved, denominator: kpi3WithData, total_completions: kpi3Total, target: 70 },
      },

      // Tab 2: End of Q1 Snapshot
      snapshot: {
        families_served: familiesServed.rows[0].count,
        active_advocates: advocateCount.rows[0].count,
        children_total: childrenCount.rows[0].total,
        moms_with_children: childrenCount.rows[0].moms_with_children,
        avg_children_per_mom: avgChildren.rows[0]?.avg_children || 0,
        moms_no_child_records: momsNoChildren.rows[0].count,
        children_welfare_involvement: childWelfareInvolvement.rows[0].count,
        families_expanded: familiesServedExpanded.rows[0],
        intake: {
          ...(intakeData.rows[0] || {}),
          ps_migrated: psMigrated.rows[0]?.count || 0,
        },
      },

      // Tab 3: FSS Deep Dive
      fss: {
        domain_scores: fssScores.rows,
        fwa_currency: fwaCurrency.rows[0],
        fwa_currency_by_affiliate: fwaCurrencyByAffiliate.rows,
      },

      // Tab 4: Affiliate Comparison (admin only)
      affiliate_comparison: affiliateComparison.rows,
      stall_by_affiliate: stallByAffiliate.rows,

      // Tab 5: Track Oversight
      track_oversight: {
        stalled_moms: stalledMoms.rows,
        stall_buckets: stallBuckets.rows[0],
        track_completions: trackCompletions.rows,
        track_completions_expanded: trackCompletionsExpanded.rows[0],
        completions_by_format: completionsByFormat.rows,
        completions_by_track: completionsByTrack.rows,
        learning_progress_by_track: learningProgressByTrack.rows,
        avg_sessions_per_track: avgSessionsPerTrack.rows,
        session_depth: sessionDepth.rows,
        sessions_by_track: sessionsByTrack.rows,
        required_sessions: REQUIRED_SESSIONS,
      },

      // Referral sources
      referral_sources: referralSources.rows,

      // Advocacy type split
      advocacy_type_split: advocacyTypeSplit.rows,

      // Advocate pipeline
      advocate_q1_activity: advocateQ1Activity.rows[0] || {},
      advocate_pipeline: {
        by_status: advocatePipeline.rows,
        by_sub_status: advocateSubStatus.rows,
      },

      // Affiliate slicer options (admin only)
      affiliates: affiliates.rows,
    });

  } catch (err) {
    console.error('Report data error:', err);
    res.status(500).json({ error: 'Failed to load report data' });
  }
});

module.exports = router;
