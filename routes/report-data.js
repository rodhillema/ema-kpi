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
// Grace window for late FWA / assessment entries after period close.
// Accommodates situations where an assessment happens at or near the end of Q1
// but isn't logged into Trellis until early Q2.
const PERIOD_GRACE_END = '2026-04-30';
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

// ─── FIPS lookups for Service Area map (Cristina v3) ────────────
// State name/abbreviation → state FIPS (2-digit).
// Covers full names + 2-letter USPS codes since Mom.primary_address_state
// isn't normalized. Case-insensitive match via uppercased key below.
const STATE_FIPS = {
  'AL':'01','ALABAMA':'01','AK':'02','ALASKA':'02','AZ':'04','ARIZONA':'04',
  'AR':'05','ARKANSAS':'05','CA':'06','CALIFORNIA':'06','CO':'08','COLORADO':'08',
  'CT':'09','CONNECTICUT':'09','DE':'10','DELAWARE':'10','DC':'11','DISTRICT OF COLUMBIA':'11',
  'FL':'12','FLORIDA':'12','GA':'13','GEORGIA':'13','HI':'15','HAWAII':'15',
  'ID':'16','IDAHO':'16','IL':'17','ILLINOIS':'17','IN':'18','INDIANA':'18',
  'IA':'19','IOWA':'19','KS':'20','KANSAS':'20','KY':'21','KENTUCKY':'21',
  'LA':'22','LOUISIANA':'22','ME':'23','MAINE':'23','MD':'24','MARYLAND':'24',
  'MA':'25','MASSACHUSETTS':'25','MI':'26','MICHIGAN':'26','MN':'27','MINNESOTA':'27',
  'MS':'28','MISSISSIPPI':'28','MO':'29','MISSOURI':'29','MT':'30','MONTANA':'30',
  'NE':'31','NEBRASKA':'31','NV':'32','NEVADA':'32','NH':'33','NEW HAMPSHIRE':'33',
  'NJ':'34','NEW JERSEY':'34','NM':'35','NEW MEXICO':'35','NY':'36','NEW YORK':'36',
  'NC':'37','NORTH CAROLINA':'37','ND':'38','NORTH DAKOTA':'38','OH':'39','OHIO':'39',
  'OK':'40','OKLAHOMA':'40','OR':'41','OREGON':'41','PA':'42','PENNSYLVANIA':'42',
  'RI':'44','RHODE ISLAND':'44','SC':'45','SOUTH CAROLINA':'45','SD':'46','SOUTH DAKOTA':'46',
  'TN':'47','TENNESSEE':'47','TX':'48','TEXAS':'48','UT':'49','UTAH':'49',
  'VT':'50','VERMONT':'50','VA':'51','VIRGINIA':'51','WA':'53','WASHINGTON':'53',
  'WV':'54','WEST VIRGINIA':'54','WI':'55','WISCONSIN':'55','WY':'56','WYOMING':'56',
};

// County name → county FIPS (5-digit, includes state prefix).
// Nested by state for scoping. Add new states as ĒMA expands.
// Current: all 67 Florida counties.
// Normalization: uppercased + "ST." and "ST " collapsed, "SAINT" allowed.
const COUNTY_FIPS = {
  '12': {
    'ALACHUA':'12001','BAKER':'12003','BAY':'12005','BRADFORD':'12007','BREVARD':'12009',
    'BROWARD':'12011','CALHOUN':'12013','CHARLOTTE':'12015','CITRUS':'12017','CLAY':'12019',
    'COLLIER':'12021','COLUMBIA':'12023','DESOTO':'12027','DIXIE':'12029','DUVAL':'12031',
    'ESCAMBIA':'12033','FLAGLER':'12035','FRANKLIN':'12037','GADSDEN':'12039','GILCHRIST':'12041',
    'GLADES':'12043','GULF':'12045','HAMILTON':'12047','HARDEE':'12049','HENDRY':'12051',
    'HERNANDO':'12053','HIGHLANDS':'12055','HILLSBOROUGH':'12057','HOLMES':'12059','INDIAN RIVER':'12061',
    'JACKSON':'12063','JEFFERSON':'12065','LAFAYETTE':'12067','LAKE':'12069','LEE':'12071',
    'LEON':'12073','LEVY':'12075','LIBERTY':'12077','MADISON':'12079','MANATEE':'12081',
    'MARION':'12083','MARTIN':'12085','MIAMI-DADE':'12086','MIAMI DADE':'12086','DADE':'12086',
    'MONROE':'12087','NASSAU':'12089','OKALOOSA':'12091','OKEECHOBEE':'12093','ORANGE':'12095',
    'OSCEOLA':'12097','PALM BEACH':'12099','PASCO':'12101','PINELLAS':'12103','POLK':'12105',
    'PUTNAM':'12107','ST. JOHNS':'12109','ST JOHNS':'12109','SAINT JOHNS':'12109',
    'ST. LUCIE':'12111','ST LUCIE':'12111','SAINT LUCIE':'12111',
    'SANTA ROSA':'12113','SARASOTA':'12115','SEMINOLE':'12117','SUMTER':'12119','SUWANNEE':'12121',
    'TAYLOR':'12123','UNION':'12125','VOLUSIA':'12127','WAKULLA':'12129','WALTON':'12131','WASHINGTON':'12133',
  },
};

// Normalize a county/state name for lookup: uppercase, trim, collapse multi-space.
function normalizeName(s) {
  if (s == null) return null;
  return String(s).trim().toUpperCase().replace(/\s+/g, ' ');
}

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
    // V2: Uses WellnessAssessment.completed_ahead to detect link-based intakes
    // instead of AuditLog blank updated_by_name rows (V1 approach)
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
      fwa_status AS (
        SELECT DISTINCT ON ("mom_id") "mom_id", "completed_ahead", "completed_date"
        FROM "WellnessAssessment"
        WHERE "deleted_at" = 0
        ORDER BY "mom_id", "created_at" ASC
      ),
      intake_dates AS (
        SELECT oo.mom_id,
          CASE WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
               THEN fs."completed_date"
               ELSE oo.coordinator_engaged_date END AS best_intake_date,
          CASE WHEN fs."completed_ahead" = true THEN 'link_based'
               ELSE 'coordinator_led' END AS intake_method
        FROM organic_only oo
        LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
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
      didNotEngageReasons,
      advocacyTypeSplit,
      advocatePipeline,
      advocateSubStatus,
      advocateActiveBreakdown,
      advocateQ1Activity,
      childWelfareInvolvement,
      familiesServedExpanded,
      kpi1,
      kpi1Excluded,
      kpi2,
      kpi3,
      intakeData,
      psMigrated,
      geoDistRaw,
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

      // V3 (Cristina 4/24): Pull domain-level scores directly from WellnessAssessment.
      //   - 11 FSS domains (cw_score excluded — tracked separately for KPI 1)
      //   - Pre/post derived temporally per mom: earliest scored WA = pre, latest = post
      //   - Mom eligible only if wa_count >= 2 (so pre != post)
      //   - Same domain names emitted as before (pre/post) for frontend back-compat;
      //     domain "name" is now the column slug (ats_score, cc_score, etc.) — Cristina
      //     can map to display labels in the HTML if needed.
      pool.query(`
        WITH scored_was AS (
          SELECT
            wa."mom_id",
            wa."ats_score", wa."cc_score", wa."edu_score", wa."ei_score", wa."fin_cpi_sum",
            wa."home_score", wa."naa_score", wa."res_score", wa."soc_score",
            wa."trnprt_score", wa."well_score",
            ROW_NUMBER() OVER (PARTITION BY wa."mom_id" ORDER BY wa."created_at" ASC)  AS rn_asc,
            ROW_NUMBER() OVER (PARTITION BY wa."mom_id" ORDER BY wa."created_at" DESC) AS rn_desc,
            COUNT(*)       OVER (PARTITION BY wa."mom_id")                              AS wa_count
          FROM "WellnessAssessment" wa
          JOIN "Mom" m ON m."id" = wa."mom_id"
          WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
            AND wa."cpi_total" IS NOT NULL
            ${affWhere}
        ),
        pre_post AS (
          SELECT
            "mom_id",
            CASE WHEN rn_asc = 1 THEN 'pre' WHEN rn_desc = 1 THEN 'post' END AS atype,
            "ats_score", "cc_score", "edu_score", "ei_score", "fin_cpi_sum",
            "home_score", "naa_score", "res_score", "soc_score", "trnprt_score", "well_score"
          FROM scored_was
          WHERE (rn_asc = 1 OR rn_desc = 1)
            AND wa_count >= 2
        ),
        unpivoted AS (
          SELECT "mom_id", atype, 'ats_score'    AS domain,  1 AS domain_order, "ats_score"::numeric    AS score FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'cc_score',     2,  "cc_score"::numeric    FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'edu_score',    3,  "edu_score"::numeric   FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'ei_score',     4,  "ei_score"::numeric    FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'fin_cpi_sum',  5,  "fin_cpi_sum"::numeric FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'home_score',   6,  "home_score"::numeric  FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'naa_score',    7,  "naa_score"::numeric   FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'res_score',    8,  "res_score"::numeric   FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'soc_score',    9,  "soc_score"::numeric   FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'trnprt_score', 10, "trnprt_score"::numeric FROM pre_post
          UNION ALL SELECT "mom_id", atype, 'well_score',   11, "well_score"::numeric  FROM pre_post
        )
        SELECT
          domain,
          domain_order,
          atype AS assessment_type,
          COUNT(DISTINCT "mom_id")::int AS mom_count,
          ROUND(AVG(score)::numeric, 2)::float AS avg_score
        FROM unpivoted
        WHERE atype IS NOT NULL AND score IS NOT NULL
        GROUP BY domain, domain_order, atype
        ORDER BY domain_order, atype
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
          AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
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
          AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
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
          AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
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
          AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
          AND m."deleted_at" = 0
          ${affWhere}
        GROUP BY t."title", t."language_type"::text
        ORDER BY total_closed DESC
      `, affParams),

      // ─── Learning Progress by Track (V3 — Cristina 4/24 spec) ─────
      //
      // Three data sources, three attribution rules:
      //   NPP → AAPIScore table (5 constructs A–E, pre+post on SAME ROW)
      //          Improvement: (A_post+B_post+C_post+D_post+E_post)
      //                     > (A_pre + B_pre + C_pre + D_pre + E_pre)
      //          Multi-enrollment: per pairing, pick most recent AAPIScore where
      //          created_at < next NPP pairing start (unbounded if no next pairing).
      //          Post scores legitimately entered after track close — do NOT bound by
      //          pairing.completed_on.
      //   EP  → AssessmentResult (Assessment.name LIKE 'Empowered Parenting%')
      //   RR  → AssessmentResult (Assessment.name LIKE 'Resilience%')
      //          Both use type='pre'/'post' + SUM(intResponse) per attempt.
      //          AR has NO pairing_id column — attribution is temporal: each post
      //          is paired with the most recent pre for the same mom + same track
      //          dated earlier. Multi-enrollment on EP/RR may undercount pending
      //          Cristina's confirmation of this approach.
      //
      // Denominator: pairs with both pre AND post on file (completion status IGNORED
      // per Cristina — pairing.completed_on is NOT the anchor).
      // Time anchor: post date (AAPIScore.created_at for NPP, AR.completedAt||created_at
      // for EP/RR) falls in Q1 period. Reason: without a time anchor, KPI reflects all
      // lifetime data, which doesn't match quarterly-report semantics. Post date = when
      // progress was measured.
      //
      // Excludes PromiseServes Legacy: legacy_ps_id IS NULL on AAPIScore,
      // Assessment.name NOT ILIKE '%Legacy%' on AR.
      pool.query(`
        WITH
        npp_pairings AS (
          SELECT p."id" AS pairing_id, p."momId",
            LEAD(p."created_at") OVER (PARTITION BY p."momId" ORDER BY p."created_at") AS next_pairing_start
          FROM "Pairing" p
          JOIN "Track" t ON t."id" = p."trackId"
          JOIN "Mom" m ON m."id" = p."momId"
          WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
            AND (t."title" ILIKE '%nurturing%' OR t."title" ILIKE '%crianza con%')
            ${affWhere}
        ),
        npp_scored AS (
          SELECT * FROM (
            SELECT
              np.pairing_id,
              (s."constructAPreAssessment"  + s."constructBPreAssessment"
               + s."constructCPreAssessment" + s."constructDPreAssessment"
               + s."constructEPreAssessment") AS pre_sum,
              (s."constructAPostAssessment" + s."constructBPostAssessment"
               + s."constructCPostAssessment" + s."constructDPostAssessment"
               + s."constructEPostAssessment") AS post_sum,
              ROW_NUMBER() OVER (PARTITION BY np.pairing_id ORDER BY s."created_at" DESC) AS rn
            FROM npp_pairings np
            JOIN "AAPIScore" s ON s."mom_id" = np."momId"
            WHERE s."deleted_at" = 0
              AND s."legacy_ps_id" IS NULL
              AND (np.next_pairing_start IS NULL OR s."created_at" < np.next_pairing_start)
              AND s."created_at" >= '${PERIOD_START}'
              AND s."created_at" <= '${PERIOD_END} 23:59:59'
              AND s."constructAPreAssessment"  IS NOT NULL AND s."constructAPostAssessment"  IS NOT NULL
              AND s."constructBPreAssessment"  IS NOT NULL AND s."constructBPostAssessment"  IS NOT NULL
              AND s."constructCPreAssessment"  IS NOT NULL AND s."constructCPostAssessment"  IS NOT NULL
              AND s."constructDPreAssessment"  IS NOT NULL AND s."constructDPostAssessment"  IS NOT NULL
              AND s."constructEPreAssessment"  IS NOT NULL AND s."constructEPostAssessment"  IS NOT NULL
          ) t WHERE rn = 1
        ),
        ep_rr_ar AS (
          SELECT
            ar."id" AS ar_id,
            ar."momId",
            ar."type"::text AS atype,
            COALESCE(ar."completedAt", ar."created_at") AS ar_date,
            CASE
              WHEN a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%' THEN 'EP'
              WHEN a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%' THEN 'RR'
              ELSE NULL
            END AS track_group,
            (SELECT SUM(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             WHERE arqr."assessmentResultId" = ar."id"
               AND arqr."deleted_at" = 0
               AND arqr."intResponse" IS NOT NULL) AS total_score
          FROM "AssessmentResult" ar
          JOIN "Assessment" a ON a."id" = ar."assessmentId"
          JOIN "Mom" m ON m."id" = ar."momId"
          WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0
            AND a."name" NOT ILIKE '%Legacy%'
            AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%'
                 OR a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%')
            ${affWhere}
        ),
        ep_rr_paired AS (
          SELECT
            post.track_group,
            post.total_score AS post_sum,
            (SELECT pre.total_score FROM ep_rr_ar pre
             WHERE pre."momId" = post."momId"
               AND pre.track_group = post.track_group
               AND pre.atype = 'pre'
               AND pre.ar_date < post.ar_date
             ORDER BY pre.ar_date DESC
             LIMIT 1) AS pre_sum
          FROM ep_rr_ar post
          WHERE post.atype = 'post'
            AND post.track_group IS NOT NULL
            AND post.ar_date >= '${PERIOD_START}'
            AND post.ar_date <= '${PERIOD_END} 23:59:59'
        ),
        all_tracks AS (
          SELECT 'NPP' AS track_group,
            (SELECT COUNT(*)::int FROM npp_pairings) AS total_completions,
            COUNT(*)::int AS valid_pairs,
            SUM(CASE WHEN post_sum > pre_sum THEN 1 ELSE 0 END)::int AS improved
          FROM npp_scored
          UNION ALL
          SELECT track_group,
            COUNT(*)::int AS total_completions,
            COUNT(CASE WHEN pre_sum IS NOT NULL THEN 1 END)::int AS valid_pairs,
            SUM(CASE WHEN pre_sum IS NOT NULL AND post_sum > pre_sum THEN 1 ELSE 0 END)::int AS improved
          FROM ep_rr_paired
          GROUP BY track_group
        )
        SELECT track_group, total_completions, valid_pairs, improved
        FROM all_tracks
        ORDER BY CASE track_group WHEN 'NPP' THEN 1 WHEN 'EP' THEN 2 WHEN 'RR' THEN 3 ELSE 4 END
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
          WHERE (s."pairing_id" = p."id" OR s."mom_id" = p."momId") AND s."deleted_at" = 0
            AND s."status"::text = 'Held' AND s."session_type"::text = 'Track_Session'
        ) track_sess ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS cnt FROM "Session" s
          WHERE (s."pairing_id" = p."id" OR s."mom_id" = p."momId") AND s."deleted_at" = 0
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
          CASE
            WHEN a."name" IS NULL AND m."referral_type_c"::text = 'self' THEN 'Self-Referral'
            WHEN a."name" IS NULL AND m."referral_type_c"::text = 'internal' THEN 'Internal Referral'
            WHEN a."name" IS NULL THEN 'Not Recorded'
            WHEN a."name" ~ '^[0-9a-f]{8}-' THEN 'Not Recorded'
            ELSE a."name"
          END AS referral_source,
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
        GROUP BY 1
        ORDER BY referrals_received DESC
      `, affParams),

      // ─── Did Not Engage reasons breakdown ──────────────────
      pool.query(`
        SELECT
          COALESCE(m."referral_sub_status"::text, 'no_reason_recorded') AS reason,
          COUNT(*)::int AS count
        FROM "Mom" m
        WHERE m."deleted_at" = 0
          AND m."prospect_status"::text = 'did_not_engage_in_program'
          AND m."created_at" >= '${PERIOD_START}'
          AND m."created_at" <= '${PERIOD_END} 23:59:59'
          ${affWhere}
        GROUP BY m."referral_sub_status"::text
        ORDER BY count DESC
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

      // ─── Advocate Active Breakdown (priority-based unique count) ──
      // Each advocate counted once in priority order:
      // 1. Group Facilitator (has active AdvocacyGroup)
      // 2. Paired 1:1 (has active pairing on mom's side, not already Group)
      // 3. Waiting to be Paired (sub-status + no pairing)
      // 4. Taking a Break (Active + Taking a Break + no pairing)
      pool.query(`
        WITH active_advocates AS (
          SELECT u."id"
          FROM "User" u
          WHERE u."deleted_at" = 0
            AND u."advocate_status"::text = 'Active'
            AND NOT EXISTS (SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r."id" = ur."role_id"
                            WHERE ur."user_id" = u."id" AND ur."deleted_at" = 0
                            AND r."key" IN ('coordinator','supervisor','staff_advocate','administrator'))
            ${affWhereUser}
        ),
        categorized AS (
          SELECT u."id",
            u."advocate_sub_status"::text AS sub_status,
            EXISTS (SELECT 1 FROM "AdvocacyGroup" ag WHERE ag."advocateId" = u."id" AND ag."state"::text = 'active' AND ag."deleted_at" = 0) AS has_group,
            EXISTS (SELECT 1 FROM "Pairing" p WHERE p."advocateUserId" = u."id" AND p."status"::text = 'paired' AND p."deleted_at" = 0) AS has_pairing
          FROM "User" u
          JOIN active_advocates aa ON aa."id" = u."id"
        )
        SELECT
          SUM(CASE WHEN has_group THEN 1 ELSE 0 END)::int AS group_facilitators,
          SUM(CASE WHEN NOT has_group AND has_pairing THEN 1 ELSE 0 END)::int AS paired_one_to_one,
          SUM(CASE WHEN NOT has_group AND NOT has_pairing AND sub_status = 'Waiting_To_Be_Paired' THEN 1 ELSE 0 END)::int AS waiting_to_be_paired,
          SUM(CASE WHEN NOT has_group AND NOT has_pairing AND sub_status = 'Taking_A_Break' THEN 1 ELSE 0 END)::int AS taking_a_break,
          SUM(CASE WHEN NOT has_group AND NOT has_pairing AND sub_status NOT IN ('Waiting_To_Be_Paired','Taking_A_Break') THEN 1 ELSE 0 END)::int AS other,
          COUNT(*)::int AS total_active
        FROM categorized
      `, affParams),

      // ─── Advocate Q1 Activity (read from User table directly) ──
      // AuditLog-based event detection was unreliable (JSON shape inconsistent,
      // Railway editor couldn't render rows for diagnosis). This version reads
      // current advocate state from the User table and anchors on created_at /
      // updated_at timestamps. Less precise than event-based tracking (won't
      // capture advocates who cycled through multiple statuses in Q1) but
      // produces real numbers that reflect Q1 activity.
      //
      // Filters:
      // - advocate_status IS NOT NULL → user was onboarded as an advocate
      // - deleted_at = 0 → active user record
      // - Applications = new advocate users created during Q1
      // - Trained = users at or past Training_Completed whose records were created in Q1
      // - Approved = users at Training_Completed specifically, created in Q1
      // - Became Active = users with advocate_status='Active' whose records were updated in Q1
      // - Became Inactive = users with advocate_status='Inactive' whose records were updated in Q1
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."advocate_status" IS NOT NULL
              AND u."deleted_at" = 0
              AND u."created_at" >= '${PERIOD_START}'
              AND u."created_at" <= '${PERIOD_END} 23:59:59'
          ) AS applications,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_sub_status"::text IN (
                'Training_Completed','Waiting_To_Be_Paired','Paired',
                'Pending_Final_Steps','Taking_A_Break'
              )
              AND u."created_at" >= '${PERIOD_START}'
              AND u."created_at" <= '${PERIOD_END} 23:59:59'
          ) AS trained,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_sub_status"::text IN (
                'Training_Completed','Waiting_To_Be_Paired','Paired','Pending_Final_Steps'
              )
              AND u."created_at" >= '${PERIOD_START}'
              AND u."created_at" <= '${PERIOD_END} 23:59:59'
          ) AS approved,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_status"::text = 'Active'
              AND u."updated_at" >= '${PERIOD_START}'
              AND u."updated_at" <= '${PERIOD_END} 23:59:59'
          ) AS became_active,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_status"::text = 'Inactive'
              AND u."updated_at" >= '${PERIOD_START}'
              AND u."updated_at" <= '${PERIOD_END} 23:59:59'
          ) AS became_inactive
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
      // Denominator: children linked to moms who had at least one FWA logged during Q1 (+ 30-day grace).
      // Numerator: ONLY children with Prevention % impact:
      //   - prevented_from_cps_involvement
      //   - prevented_from_foster_care_placement
      // Everything else (prevented_from_permanent_removal, temporary_removal,
      // permanent_removal) is in denominator but NOT numerator.
      //
      // EXCLUDES PromiseServes Legacy data (pre-Trellis migration records).
      // Only current-system assessments (EP, RR, future AAPI templates) count.
      //
      // PERIOD-ANCHORED: counts are stable regardless of when the Q1 report is viewed.
      // Does NOT require mom.status='active' now — moms who were active during Q1 are included
      // even if they have since gone inactive.
      //
      // V3 (Cristina 4/24): Moved from AssessmentResult to WellnessAssessment.
      //   - Filter: cpi_total IS NOT NULL (substantive-assessment marker — 333 of 453 rows qualify)
      //   - Window: 3 months ending period end (was 4-month grace window on AR)
      //   - Date column: updated_at per Cristina's original spec language
      // Reference: Family Preservation Impact methodology
      pool.query(`
        WITH moms_with_period_fwa AS (
          SELECT DISTINCT wa."mom_id" AS "momId"
          FROM "WellnessAssessment" wa
          JOIN "Mom" m ON m."id" = wa."mom_id"
          WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
            AND wa."cpi_total" IS NOT NULL
            AND wa."updated_at" >= '${PERIOD_START}'
            AND wa."updated_at" <= '${PERIOD_END} 23:59:59'
            ${affWhere}
        )
        SELECT
          COUNT(c."id")::int AS denominator,
          SUM(CASE WHEN c."family_preservation_impact" IN ('prevented_from_cps_involvement', 'prevented_from_foster_care_placement') THEN 1 ELSE 0 END)::int AS numerator
        FROM "Child" c
        JOIN moms_with_period_fwa f ON f."momId" = c."mom_id"
        WHERE c."deleted_at" = 0
      `, affParams),

      // Count children excluded (moms served during Q1 but had no Q1-valid scored
      // WellnessAssessment). V3: substantive-assessment marker is cpi_total IS NOT NULL
      // on WellnessAssessment; drafts without scoring don't qualify a mom's children.
      // "Served during Q1" = had an active pairing or held session at any point in Q1,
      // OR their intake_date falls in Q1.
      pool.query(`
        SELECT COUNT(c."id")::int AS count
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        WHERE c."deleted_at" = 0 AND m."deleted_at" = 0
          AND NOT EXISTS (
            SELECT 1 FROM "WellnessAssessment" wa
            WHERE wa."mom_id" = m."id" AND wa."deleted_at" = 0
              AND wa."cpi_total" IS NOT NULL
              AND wa."updated_at" >= '${PERIOD_START}'
              AND wa."updated_at" <= '${PERIOD_END} 23:59:59'
          )
          AND (
            EXISTS (
              SELECT 1 FROM "Pairing" p
              WHERE p."momId" = m."id" AND p."deleted_at" = 0
                AND p."created_at" <= '${PERIOD_END} 23:59:59'
                AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            )
            OR EXISTS (
              SELECT 1 FROM "Session" s
              JOIN "Pairing" p2 ON p2."id" = s."pairing_id"
              WHERE p2."momId" = m."id" AND s."deleted_at" = 0
                AND s."status"::text = 'Held'
                AND s."date_start" >= '${PERIOD_START}' AND s."date_start" <= '${PERIOD_END} 23:59:59'
            )
          )
          ${affWhere}
      `, affParams),

      // KPI 2 — FSS Improvement Rate (target 70%)
      //
      // V3 (Cristina 4/24): Moved off AssessmentResult onto WellnessAssessment.
      //   - FSS formula: ats_score + cc_score + edu_score + ei_score + fin_cpi_sum
      //                + home_score + naa_score + res_score + soc_score
      //                + trnprt_score + well_score   (11 domains, max 356)
      //   - cw_score is EXCLUDED from FSS (tracked separately for KPI 1)
      //   - cpi_total is NOT used (turned out to not be a clean sum of domain scores)
      //   - Pre/post: no type column on WA, so derived temporally:
      //       pre  = earliest scored WA per mom by created_at
      //       post = latest   scored WA per mom by created_at
      //       Mom eligible only if earliest != latest AND both rows have all 11 scores
      //   - "Scored" = cpi_total IS NOT NULL (333 of 453 rows qualify; same population
      //      in practice as checking each score column individually)
      //   - ei_score chosen over ei_cpi_sum per Cristina's default; they differ on
      //      34% of rows — revisit if she changes her mind.
      //   - No Pairing.completed_on anchor: Cristina's v3 spec derives pre/post
      //      directly from the WA population. Flag if she meant to keep pairing anchor.
      pool.query(`
        WITH scored_was AS (
          SELECT
            wa."mom_id",
            wa."created_at",
            (COALESCE(wa."ats_score",0) + COALESCE(wa."cc_score",0) + COALESCE(wa."edu_score",0)
             + COALESCE(wa."ei_score",0) + COALESCE(wa."fin_cpi_sum",0) + COALESCE(wa."home_score",0)
             + COALESCE(wa."naa_score",0) + COALESCE(wa."res_score",0) + COALESCE(wa."soc_score",0)
             + COALESCE(wa."trnprt_score",0) + COALESCE(wa."well_score",0)) AS fss_total,
            ROW_NUMBER() OVER (PARTITION BY wa."mom_id" ORDER BY wa."created_at" ASC)  AS rn_asc,
            ROW_NUMBER() OVER (PARTITION BY wa."mom_id" ORDER BY wa."created_at" DESC) AS rn_desc,
            COUNT(*)        OVER (PARTITION BY wa."mom_id")                              AS wa_count
          FROM "WellnessAssessment" wa
          JOIN "Mom" m ON m."id" = wa."mom_id"
          WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
            AND wa."cpi_total" IS NOT NULL
            ${affWhere}
        ),
        mom_pre_post AS (
          SELECT
            "mom_id",
            MAX(CASE WHEN rn_asc  = 1 THEN fss_total END) AS pre_fss,
            MAX(CASE WHEN rn_desc = 1 THEN fss_total END) AS post_fss,
            MAX(wa_count) AS wa_count
          FROM scored_was
          GROUP BY "mom_id"
        )
        SELECT
          COUNT(*)::int AS denominator,
          SUM(CASE WHEN post_fss > pre_fss THEN 1 ELSE 0 END)::int AS numerator
        FROM mom_pre_post
        WHERE wa_count >= 2
          AND pre_fss IS NOT NULL
          AND post_fss IS NOT NULL
      `, affParams),

      // KPI 3 — Learning Progress (target 70%)
      //
      // V3 (Cristina 4/24): Three data sources, three attribution rules.
      //   NPP → AAPIScore (5-construct A–E total, pre+post on same row)
      //   EP  → AssessmentResult + Assessment.name LIKE 'Empowered Parenting%'
      //   RR  → AssessmentResult + Assessment.name LIKE 'Resilience%'
      //
      // Denominator: pairs with both pre AND post on file. Completion status IGNORED
      // (pairing.completed_on NOT the anchor per Cristina). Time scoping: post date in Q1.
      //
      // NPP multi-enrollment: most recent AAPIScore.created_at before next NPP pairing
      // start (unbounded if no next pairing). Post scores can legitimately be entered
      // after track close, so pairing.completed_on is not a bound.
      //
      // EP/RR caveat: AssessmentResult has NO pairing_id column — attribution is temporal
      // (most recent pre before each post, same mom + same track). Flagged for Cristina.
      //
      // Shape matches learning_progress_by_track (same CTE chain); this is the rolled-up
      // total across all 3 tracks for the top-line KPI 3 rate.
      pool.query(`
        WITH
        npp_pairings AS (
          SELECT p."id" AS pairing_id, p."momId",
            LEAD(p."created_at") OVER (PARTITION BY p."momId" ORDER BY p."created_at") AS next_pairing_start
          FROM "Pairing" p
          JOIN "Track" t ON t."id" = p."trackId"
          JOIN "Mom" m ON m."id" = p."momId"
          WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
            AND (t."title" ILIKE '%nurturing%' OR t."title" ILIKE '%crianza con%')
            ${affWhere}
        ),
        npp_scored AS (
          SELECT * FROM (
            SELECT
              np.pairing_id,
              (s."constructAPreAssessment"  + s."constructBPreAssessment"
               + s."constructCPreAssessment" + s."constructDPreAssessment"
               + s."constructEPreAssessment") AS pre_sum,
              (s."constructAPostAssessment" + s."constructBPostAssessment"
               + s."constructCPostAssessment" + s."constructDPostAssessment"
               + s."constructEPostAssessment") AS post_sum,
              ROW_NUMBER() OVER (PARTITION BY np.pairing_id ORDER BY s."created_at" DESC) AS rn
            FROM npp_pairings np
            JOIN "AAPIScore" s ON s."mom_id" = np."momId"
            WHERE s."deleted_at" = 0
              AND s."legacy_ps_id" IS NULL
              AND (np.next_pairing_start IS NULL OR s."created_at" < np.next_pairing_start)
              AND s."created_at" >= '${PERIOD_START}'
              AND s."created_at" <= '${PERIOD_END} 23:59:59'
              AND s."constructAPreAssessment"  IS NOT NULL AND s."constructAPostAssessment"  IS NOT NULL
              AND s."constructBPreAssessment"  IS NOT NULL AND s."constructBPostAssessment"  IS NOT NULL
              AND s."constructCPreAssessment"  IS NOT NULL AND s."constructCPostAssessment"  IS NOT NULL
              AND s."constructDPreAssessment"  IS NOT NULL AND s."constructDPostAssessment"  IS NOT NULL
              AND s."constructEPreAssessment"  IS NOT NULL AND s."constructEPostAssessment"  IS NOT NULL
          ) t WHERE rn = 1
        ),
        ep_rr_ar AS (
          SELECT
            ar."id" AS ar_id,
            ar."momId",
            ar."type"::text AS atype,
            COALESCE(ar."completedAt", ar."created_at") AS ar_date,
            CASE
              WHEN a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%' THEN 'EP'
              WHEN a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%' THEN 'RR'
              ELSE NULL
            END AS track_group,
            (SELECT SUM(arqr."intResponse") FROM "AssessmentResultQuestionResponse" arqr
             WHERE arqr."assessmentResultId" = ar."id"
               AND arqr."deleted_at" = 0
               AND arqr."intResponse" IS NOT NULL) AS total_score
          FROM "AssessmentResult" ar
          JOIN "Assessment" a ON a."id" = ar."assessmentId"
          JOIN "Mom" m ON m."id" = ar."momId"
          WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0
            AND a."name" NOT ILIKE '%Legacy%'
            AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%'
                 OR a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%')
            ${affWhere}
        ),
        ep_rr_paired AS (
          SELECT
            post.total_score AS post_sum,
            (SELECT pre.total_score FROM ep_rr_ar pre
             WHERE pre."momId" = post."momId"
               AND pre.track_group = post.track_group
               AND pre.atype = 'pre'
               AND pre.ar_date < post.ar_date
             ORDER BY pre.ar_date DESC
             LIMIT 1) AS pre_sum
          FROM ep_rr_ar post
          WHERE post.atype = 'post'
            AND post.track_group IS NOT NULL
            AND post.ar_date >= '${PERIOD_START}'
            AND post.ar_date <= '${PERIOD_END} 23:59:59'
        ),
        combined AS (
          SELECT post_sum, pre_sum FROM npp_scored
          UNION ALL
          SELECT post_sum, pre_sum FROM ep_rr_paired WHERE pre_sum IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM npp_pairings)
            + (SELECT COUNT(*)::int FROM ep_rr_paired) AS total_completions,
          COUNT(*)::int AS with_pre_post,
          SUM(CASE WHEN post_sum > pre_sum THEN 1 ELSE 0 END)::int AS improved
        FROM combined
      `, affParams),

      // ─── Intake Date (derived from AuditLog) ─────────────────

      // Intake date V2: uses WellnessAssessment.completed_ahead for link-based detection
      pool.query(`
        WITH ${INTAKE_CTE}
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

      // ─── Service Area: geographic distribution (Cristina v3) ──
      // Same active-during-period cohort as familiesServed (mom has a paired
      // Pairing overlapping Q1). Text state/county comes raw from Mom;
      // FIPS mapping happens in post-processing via STATE_FIPS / COUNTY_FIPS.
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(m."primary_address_state"), ''), 'UNKNOWN')    AS state_name,
          COALESCE(NULLIF(TRIM(m."primary_address_county_c"), ''), 'UNKNOWN') AS county_name,
          COUNT(DISTINCT m."id")::int AS count
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
        GROUP BY 1, 2
      `, affParams),

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

    // ─── Service Area: map raw state/county text → FIPS codes ─
    // Rows unmappable by either lookup are dropped silently with a debug log
    // (so they don't poison the chart). If a whole affiliate shows zeros,
    // the "No location data available" fallback triggers correctly.
    const geoByKey = {};
    let geoUnmapped = 0;
    for (const r of (geoDistRaw.rows || [])) {
      const stateKey = normalizeName(r.state_name);
      const countyKey = normalizeName(r.county_name);
      const stateFips = STATE_FIPS[stateKey];
      if (!stateFips) { geoUnmapped += r.count; continue; }
      const countyFips = COUNTY_FIPS[stateFips]?.[countyKey];
      if (!countyFips) { geoUnmapped += r.count; continue; }
      const k = countyFips;
      if (!geoByKey[k]) geoByKey[k] = { state_fips: stateFips, county_fips: countyFips, count: 0 };
      geoByKey[k].count += r.count;
    }
    const geographicDistribution = Object.values(geoByKey);
    if (geoUnmapped > 0) {
      console.log(`[geographic_distribution] ${geoUnmapped} moms dropped from map (unmapped state/county)`);
    }

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
        // KPI 1 numerator exposed directly for the Child Welfare Prevention card
        // and Cristina's report hydration. Count of children with
        // family_preservation_impact IN (prevented_from_cps_involvement,
        // prevented_from_foster_care_placement). Dollar value is count × $38,850
        // computed client-side.
        children_prevented_cps_fc: kpi1Num,
        // Q1 Activity strip aliases — Cristina's report reads these from snap.
        // Backing fields are the period-scoped advocate_q1_activity counts
        // (User-table-direct, anchored on created_at / updated_at per Q1 window).
        adv_applications_received: advocateQ1Activity.rows[0]?.applications || 0,
        adv_trained: advocateQ1Activity.rows[0]?.trained || 0,
        adv_approved: advocateQ1Activity.rows[0]?.approved || 0,
        adv_became_active: advocateQ1Activity.rows[0]?.became_active || 0,
        adv_became_inactive: advocateQ1Activity.rows[0]?.became_inactive || 0,
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
      did_not_engage_reasons: didNotEngageReasons.rows,

      // Advocacy type split
      advocacy_type_split: advocacyTypeSplit.rows,

      // Advocate pipeline
      advocate_active_breakdown: advocateActiveBreakdown.rows[0] || {},
      // Remapped view of advocate_active_breakdown with Cristina's key names.
      // Report's advocate status chart reads from here: { paired_1_1, group, waiting, on_break }.
      // Keeping advocate_active_breakdown for back-compat with any other consumers.
      advocate_status_buckets: {
        paired_1_1: advocateActiveBreakdown.rows[0]?.paired_one_to_one || 0,
        group: advocateActiveBreakdown.rows[0]?.group_facilitators || 0,
        waiting: advocateActiveBreakdown.rows[0]?.waiting_to_be_paired || 0,
        on_break: advocateActiveBreakdown.rows[0]?.taking_a_break || 0,
      },
      advocate_q1_activity: advocateQ1Activity.rows[0] || {},
      advocate_pipeline: {
        by_status: advocatePipeline.rows,
        by_sub_status: advocateSubStatus.rows,
      },

      // Service Area tab (Cristina's v3 report).
      // Shape: [{ state_fips: '12', county_fips: '12011', count: 142 }, ...]
      // Built from Mom.primary_address_state + primary_address_county_c, mapped
      // through STATE_FIPS / COUNTY_FIPS constants at top of file. If zero rows
      // make it through (no addressed moms in scope), frontend falls back to
      // __DEMO_GEO__ since the array will be empty — actually for that to work
      // we must send null; but an empty array means "real data attempted, zero
      // addressed moms" which is a legitimate state. Send empty array here so
      // the map correctly shows "No location data available" rather than demo.
      geographic_distribution: geographicDistribution,

      // Affiliate slicer options (admin only)
      affiliates: affiliates.rows,
    });

  } catch (err) {
    console.error('Report data error:', err);
    res.status(500).json({ error: 'Failed to load report data' });
  }
});

module.exports = router;
