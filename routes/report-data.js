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
const ORG_WIDE_ROLES = ['administrator', 'supervisor'];

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
    if (isOrgWideRole && req.query.affiliate_id) {
      affiliateFilter = req.query.affiliate_id;
    }
    const isOrgWide = isOrgWideRole && !req.query.affiliate_id;

    // Look up selected affiliate name (when admin/champion picks a different affiliate)
    let affiliateName = req.session.user.affiliateName;
    if (isOrgWideRole && req.query.affiliate_id) {
      const affNameResult = await pool.query(
        `SELECT "name" FROM "Affiliate" WHERE "id" = $1 AND "deleted_at" = 0 LIMIT 1`,
        [req.query.affiliate_id]
      );
      affiliateName = affNameResult.rows[0]?.name || 'Unknown Affiliate';
    }

    // Build WHERE clause for affiliate scoping
    const affWhere = isOrgWide ? '' : `AND m."affiliate_id" = $1`;
    const affWhereUser = isOrgWide ? '' : `AND u."affiliateId" = $1`;
    const affParams = isOrgWide ? [] : [affiliateFilter];

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
        SELECT a.data->>'id' AS mom_id, MIN(a.created_at) AS self_complete_date
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

    // ─── TAB 1: KPIs & Status ───────────────────────────────
    const momStatusCounts = await pool.query(`
      SELECT m."status"::text AS status, COUNT(*)::int AS count
      FROM "Mom" m
      WHERE m."deleted_at" = 0 ${affWhere}
      GROUP BY m."status"::text
      ORDER BY 1
    `, affParams);

    // Active in track (paired pairings)
    const activeInTrack = await pool.query(`
      SELECT COUNT(DISTINCT p."momId")::int AS count
      FROM "Pairing" p
      JOIN "Mom" m ON m."id" = p."momId"
      WHERE p."deleted_at" = 0
        AND p."status"::text = 'paired'
        AND m."deleted_at" = 0
        ${affWhere}
    `, affParams);

    // Membership community: active mom + no active pairing
    const membershipCommunity = await pool.query(`
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
    `, affParams);

    // Sessions held in period
    const sessionsInPeriod = await pool.query(`
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
    `, affParams);

    // ─── TAB 2: End of Q1 Snapshot ──────────────────────────

    // Families served (active-during-period logic)
    const familiesServed = await pool.query(`
      SELECT COUNT(DISTINCT m."id")::int AS count
      FROM "Mom" m
      JOIN "Pairing" p ON p."momId" = m."id"
      WHERE m."deleted_at" = 0
        AND p."deleted_at" = 0
        AND p."status"::text = 'paired'
        AND p."created_at" <= '${PERIOD_END} 23:59:59'
        AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
        ${affWhere}
    `, affParams);

    // Active advocates (distinct advocate users with active pairings)
    const advocateCount = await pool.query(`
      SELECT COUNT(DISTINCT p."advocateUserId")::int AS count
      FROM "Pairing" p
      JOIN "Mom" m ON m."id" = p."momId"
      WHERE p."deleted_at" = 0
        AND p."status"::text = 'paired'
        AND m."deleted_at" = 0
        ${affWhere}
    `, affParams);

    // Children count (children of active moms)
    const childrenCount = await pool.query(`
      SELECT COUNT(c."id")::int AS total,
             COUNT(DISTINCT c."mom_id")::int AS moms_with_children
      FROM "Child" c
      JOIN "Mom" m ON m."id" = c."mom_id"
      WHERE c."deleted_at" = 0
        AND m."deleted_at" = 0
        AND m."status"::text = 'active'
        ${affWhere}
    `, affParams);

    // Average children per mom (for proxy calculation)
    const avgChildren = await pool.query(`
      SELECT ROUND(AVG(child_count)::numeric, 2)::float AS avg_children
      FROM (
        SELECT c."mom_id", COUNT(*)::int AS child_count
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        WHERE c."deleted_at" = 0 AND m."deleted_at" = 0 AND m."status"::text = 'active'
          ${affWhere}
        GROUP BY c."mom_id"
      ) sub
    `, affParams);

    // Moms with no child records
    const momsNoChildren = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM "Mom" m
      WHERE m."deleted_at" = 0
        AND m."status"::text = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM "Child" c WHERE c."mom_id" = m."id" AND c."deleted_at" = 0
        )
        ${affWhere}
    `, affParams);

    // ─── TAB 3: FSS Deep Dive ───────────────────────────────

    // Assessment results with construct-level scores
    // Get all completed assessment results for moms in scope
    const fssScores = await pool.query(`
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
    `, affParams);

    // ─── TAB 4: Affiliate Comparison ────────────────────────

    let affiliateComparison = [];
    if (isOrgWide) {
      affiliateComparison = (await pool.query(`
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
      `)).rows;
    }

    // ─── TAB 5: Track Oversight ─────────────────────────────

    // Stalled moms: active pairing, last held session > 14 days ago
    const stalledMoms = await pool.query(`
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
    `, affParams);

    // Track completions in period
    const trackCompletions = await pool.query(`
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
    `, affParams);

    // Session depth per active pairing (for fidelity check)
    const sessionDepth = await pool.query(`
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
    `, affParams);

    // ─── NEW: Stall Buckets (4-card summary) ────────────────

    const stallBuckets = await pool.query(`
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
    `, affParams);

    // ─── NEW: Stall by Affiliate Table ──────────────────────

    let stallByAffiliate = [];
    if (isOrgWide) {
      stallByAffiliate = (await pool.query(`
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
      `)).rows;
    }

    // ─── NEW: FWA Currency ──────────────────────────────────

    const fwaCurrency = await pool.query(`
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
    `, affParams);

    // FWA currency by affiliate (for bar chart)
    let fwaCurrencyByAffiliate = [];
    if (isOrgWide) {
      fwaCurrencyByAffiliate = (await pool.query(`
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
      `)).rows;
    }

    // ─── NEW: Referral Sources ──────────────────────────────

    const referralSources = await pool.query(`
      WITH ${INTAKE_CTE}
      SELECT
        m."referral_type_c"::text AS referral_source,
        COUNT(*)::int AS referrals_received,
        SUM(CASE WHEN EXISTS (
            SELECT 1 FROM "Pairing" p
            WHERE p."momId" = m."id"
              AND p."deleted_at" = 0
              AND p."status"::text IN ('paired', 'pairing_complete')
          )
        THEN 1 ELSE 0 END)::int AS intakes_completed,
        SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM "Pairing" p
            WHERE p."momId" = m."id"
              AND p."deleted_at" = 0
              AND p."status"::text IN ('paired', 'pairing_complete')
          )
        THEN 1 ELSE 0 END)::int AS pending
      FROM "Mom" m
      JOIN intake_dates id ON id.mom_id = m."id"
      WHERE m."deleted_at" = 0
        AND id.best_intake_date >= '${PERIOD_START}'
        AND id.best_intake_date <= '${PERIOD_END} 23:59:59'
        ${affWhere}
      GROUP BY m."referral_type_c"::text
      ORDER BY referrals_received DESC
    `, affParams);

    // ─── NEW: Session Counts by Track ───────────────────────

    const sessionsByTrack = await pool.query(`
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
    `, affParams);

    // ─── NEW: Advocacy Type Split ───────────────────────────

    const advocacyTypeSplit = await pool.query(`
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
    `, affParams);

    // ─── NEW: Advocate Pipeline ─────────────────────────────

    const advocatePipeline = await pool.query(`
      SELECT
        u."advocate_status"::text AS advocate_status,
        COUNT(*)::int AS count
      FROM "User" u
      WHERE u."deleted_at" = 0
        ${affWhereUser}
      GROUP BY u."advocate_status"::text
      ORDER BY u."advocate_status"::text
    `, affParams);

    const advocateSubStatus = await pool.query(`
      SELECT
        u."advocate_sub_status"::text AS advocate_sub_status,
        COUNT(*)::int AS count
      FROM "User" u
      WHERE u."deleted_at" = 0
        AND u."advocate_sub_status" IS NOT NULL
        ${affWhereUser}
      GROUP BY u."advocate_sub_status"::text
      ORDER BY u."advocate_sub_status"::text
    `, affParams);

    // ─── NEW: Children with Welfare Involvement ─────────────

    const childWelfareInvolvement = await pool.query(`
      SELECT COUNT(c."id")::int AS count
      FROM "Child" c
      JOIN "Mom" m ON m."id" = c."mom_id"
      WHERE c."deleted_at" = 0
        AND m."deleted_at" = 0
        AND m."status"::text = 'active'
        AND c."active_child_welfare_involvement" IS NOT NULL
        AND c."active_child_welfare_involvement"::text <> ''
        ${affWhere}
    `, affParams);

    // ─── NEW: Track Completions Expanded ────────────────────

    const trackCompletionsExpanded = await pool.query(`
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
    `, affParams);

    // ─── NEW: Families Served Expanded ──────────────────────

    const familiesServedExpanded = await pool.query(`
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
    `, affParams);

    // ─── Affiliate list (for admin slicer) ──────────────────

    let affiliates = [];
    if (isOrgWideRole) {
      affiliates = (await pool.query(`
        SELECT "id", "name" FROM "Affiliate"
        WHERE "deleted_at" = 0
        ORDER BY "name"
      `)).rows;
    }

    // ─── KPI Calculations ────────────────────────────────────

    // KPI 1 — Family Preservation Rate (target 85%)
    // Denominator: children linked to active moms with FWA in last 90 days
    // Numerator: of those, children NOT permanently removed
    const kpi1 = await pool.query(`
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
        SUM(CASE WHEN c."family_preservation_impact" IS DISTINCT FROM 'permanent_removal' THEN 1 ELSE 0 END)::int AS numerator
      FROM "Child" c
      JOIN moms_with_current_fwa f ON f."momId" = c."mom_id"
      WHERE c."deleted_at" = 0
    `, affParams);

    const kpi1Num = kpi1.rows[0]?.numerator || 0;
    const kpi1Den = kpi1.rows[0]?.denominator || 0;
    const kpi1Rate = kpi1Den > 0 ? Math.round(1000 * kpi1Num / kpi1Den) / 10 : null;

    // Count children excluded (active moms with no valid FWA)
    const kpi1Excluded = await pool.query(`
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
    `, affParams);

    // KPI 2 — FSS Improvement Rate (target 70%)
    // Moms with pre+post assessment where composite improved
    const kpi2 = await pool.query(`
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
    `, affParams);

    const kpi2Num = kpi2.rows[0]?.numerator || 0;
    const kpi2Den = kpi2.rows[0]?.denominator || 0;
    const kpi2Rate = kpi2Den > 0 ? Math.round(1000 * kpi2Num / kpi2Den) / 10 : null;

    // KPI 3 — Learning Progress (target 70%)
    // Track completions in Q1 with pre/post improvement
    const kpi3 = await pool.query(`
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
    `, affParams);

    const kpi3Total = kpi3.rows[0]?.total_completions || 0;
    const kpi3WithData = kpi3.rows[0]?.with_pre_post || 0;
    const kpi3Improved = kpi3.rows[0]?.improved || 0;
    const kpi3Rate = kpi3WithData > 0 ? Math.round(1000 * kpi3Improved / kpi3WithData) / 10 : null;

    // ─── Intake Date (derived from AuditLog) ─────────────────

    // Intake date methodology: derived from AuditLog prospect_status = 'engaged_in_program'
    // Excludes PS-migrated moms (Nov 30 / Dec 17 2025 batches)
    // Link-based intakes use first blank updated_by_name row after coordinator's engaged event
    const intakeData = await pool.query(`
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
    `, affParams);

    // Count PS-migrated moms (excluded from intake calculations)
    const psMigrated = await pool.query(`
      SELECT COUNT(DISTINCT data->>'id')::int AS count
      FROM "AuditLog"
      WHERE "table" = 'Mom'
        AND action = 'Update'
        AND data->>'prospect_status' = 'engaged_in_program'
        AND DATE_TRUNC('day', created_at) IN ('2025-11-30', '2025-12-17')
    `);

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
        fwa_currency_by_affiliate: fwaCurrencyByAffiliate,
      },

      // Tab 4: Affiliate Comparison (admin only)
      affiliate_comparison: affiliateComparison,
      stall_by_affiliate: stallByAffiliate,

      // Tab 5: Track Oversight
      track_oversight: {
        stalled_moms: stalledMoms.rows,
        stall_buckets: stallBuckets.rows[0],
        track_completions: trackCompletions.rows,
        track_completions_expanded: trackCompletionsExpanded.rows[0],
        session_depth: sessionDepth.rows,
        sessions_by_track: sessionsByTrack.rows,
        required_sessions: REQUIRED_SESSIONS,
      },

      // Referral sources
      referral_sources: referralSources.rows,

      // Advocacy type split
      advocacy_type_split: advocacyTypeSplit.rows,

      // Advocate pipeline
      advocate_pipeline: {
        by_status: advocatePipeline.rows,
        by_sub_status: advocateSubStatus.rows,
      },

      // Affiliate slicer options (admin only)
      affiliates: affiliates,
    });

  } catch (err) {
    console.error('Report data error:', err);
    res.status(500).json({ error: 'Failed to load report data' });
  }
});

module.exports = router;
