/* ============================================================
   /api/report-data — KPI Report Data Endpoint
   Returns the full data envelope for all 5 dashboard tabs.
   Scoped by affiliate for coordinator/staff_advocate roles.
   Admin sees all; optional ?affiliate_id= param to filter.
   ============================================================ */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { COUNTY_FIPS, COUNTY_NAME_BY_FIPS } = require('../lib/county-fips');
const { lookupZipCounty } = require('../lib/zip-to-county');

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

// Usernames granted org-wide access regardless of role
const ORG_WIDE_USERNAMES = ['cristina.galloway'];

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

// COUNTY_FIPS now lives in lib/county-fips.js (8 states: FL/OH/AZ/CA/IN/NY/KY/GA,
// 661 counties total — covers ~95% of ĒMA mom volume per the 4/24/26 distinct-state
// query). Add states there as ĒMA expands.

// Normalize a county/state name for lookup: uppercase, trim, collapse multi-space.
function normalizeName(s) {
  if (s == null) return null;
  return String(s).trim().toUpperCase().replace(/\s+/g, ' ');
}

// Normalize a raw county text value into a clean county name suitable for
// lookup AND display, OR return null if it's clearly junk (street address,
// state code, country name, etc.). Used by both the map FIPS lookup and
// the Counties Served panel so duplicates merge and junk surfaces as 'Unknown'.
//
// Examples:
//   'Broward'             → 'Broward'
//   'Broward county'      → 'Broward'  (suffix stripped)
//   'BROWARD'             → 'Broward'  (case-folded)
//   'Miami-Dade'          → 'Miami-Dade'
//   '2582 Riverside Dr'   → null  (street address)
//   '1217 Star Dust'      → null  (leading digits = address-shaped)
//   'FL' / 'Florida'      → null  (state value in county field)
//   'United States' / 'USA' → null (country in county field)
//   ''                    → null
const NON_COUNTY_TOKENS = new Set([
  'UNITED STATES', 'USA', 'U.S.', 'U.S.A.', 'AMERICA', 'US',
  'NULL', 'NONE', 'N/A', 'NA', 'TBD', 'TEST',
]);
function normalizeCountyName(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s.toLowerCase() === 'unknown') return null;
  // Address-shaped: any string containing a digit is almost certainly not
  // a county (US county names are alpha-only). This catches '2582 Riverside Dr',
  // '1217 Star Dust', '#42', etc. without needing a perfect street-suffix list.
  if (/\d/.test(s)) return null;
  // Strip trailing ' county' (case-insensitive) so 'Broward county' = 'Broward'.
  s = s.replace(/\s+county\s*$/i, '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  // Reject state codes/full state names (someone entered the state in the county field).
  if (STATE_FIPS[upper]) return null;
  // Reject known country names and meaningless placeholders.
  if (NON_COUNTY_TOKENS.has(upper)) return null;
  // Reject very short single tokens that aren't real county names (e.g. 'XX', 'Z').
  if (s.length < 3) return null;
  // Title-case for display: 'BROWARD' → 'Broward', 'miami-dade' → 'Miami-Dade'.
  s = s.toLowerCase()
       .split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
       .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
  return s || null;
}

router.get('/', async (req, res) => {
  try {
    const { role, affiliateId, username } = req.session.user;

    // Determine affiliate filter
    // Champions with no affiliateId are org-wide (like admin)
    const isOrgWideRole = ORG_WIDE_ROLES.includes(role) || (role === 'champion' && !affiliateId) || ORG_WIDE_USERNAMES.includes((username || '').toLowerCase());
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
      momLocationsRaw,
      topZipCodesRaw,
      raceDistRaw,
      ageDistRaw,
      languageDistRaw,
      pregnancyDistRaw,
      childrenInHomeRaw,
      childrenAvgAgeRaw,
      caregiverDistRaw,
      maritalDistRaw,
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

      // ─── Track Completions Expanded ─────────────────────────
      // RD 4/25/26 (item #18): Completion bucketing is DATA-DERIVED per
      // Cristina's quarterly-impact.html spec, not from p.complete_reason_sub_status
      // dropdown. Cristina's definitions (line 2357 of her v3 file):
      //   - Full Track: required curriculum sessions held + ≥1 support session + post-assessment on file
      //   - Without Support Sessions: curriculum complete + post on file + 0 support sessions
      //   - Without Post Assessment: curriculum complete + no post-assessment on file
      // Mutually-exclusive precedence:
      //   IF post AND support>=1 → Full Track
      //   ELIF post AND support=0 → Without Support Sessions
      //   ELSE (no post)         → Without Post Assessment
      //
      // "Required" sessions per curriculum: NPP/Crianza-con=10, EP/Crianza-empoderada=8,
      // RR/Roadmap/Hoja-de-ruta=4.
      //
      // Post-assessment lookup is dual-source (matches KPI 3 split):
      //   NPP   → AAPIScore row exists with any post column populated
      //   EP/RR → AssessmentResult.type='post' with matching Assessment.name
      //
      // Incomplete buckets stay on the dropdown enum — "why" is inherently
      // subjective (Client Choice, Relocated, Other) and not derivable.
      pool.query(`
        WITH q1_pairings AS (
          SELECT p."id" AS pairing_id, p."momId",
            p."complete_reason_sub_status"::text AS complete_reason,
            p."incomplete_reason_sub_status"::text AS incomplete_reason,
            CASE
              WHEN t."title" ILIKE '%nurturing%' OR t."title" ILIKE '%crianza con%' THEN 10
              WHEN t."title" ILIKE '%empowered%' OR t."title" ILIKE '%crianza empoderada%' THEN 8
              WHEN t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%resilien%' OR t."title" ILIKE '%hoja de ruta%' THEN 4
              ELSE NULL
            END AS required_track_sessions,
            CASE
              WHEN t."title" ILIKE '%nurturing%' OR t."title" ILIKE '%crianza con%' THEN 'NPP'
              WHEN t."title" ILIKE '%empowered%' OR t."title" ILIKE '%crianza empoderada%' THEN 'EP'
              WHEN t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%resilien%' OR t."title" ILIKE '%hoja de ruta%' THEN 'RR'
              ELSE 'Other'
            END AS track_group
          FROM "Pairing" p
          JOIN "Track" t ON t."id" = p."trackId"
          JOIN "Mom" m ON m."id" = p."momId"
          WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
            AND p."status"::text = 'pairing_complete'
            AND p."completed_on" >= '${PERIOD_START}'
            AND p."completed_on" <= '${PERIOD_END} 23:59:59'
            AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
            ${affWhere}
        ),
        completed_only AS (
          SELECT * FROM q1_pairings WHERE complete_reason IS NOT NULL
        ),
        session_counts AS (
          SELECT
            qp.pairing_id,
            COUNT(*) FILTER (WHERE s."status"::text = 'Held' AND s."session_type"::text = 'Track_Session')::int AS track_held,
            COUNT(*) FILTER (WHERE s."status"::text = 'Held' AND s."session_type"::text = 'Support_Session')::int AS support_held
          FROM completed_only qp
          LEFT JOIN "Session" s ON s."pairing_id" = qp.pairing_id AND s."deleted_at" = 0
          GROUP BY qp.pairing_id
        ),
        post_assessment AS (
          SELECT qp.pairing_id,
            CASE
              WHEN qp.track_group = 'NPP' THEN EXISTS (
                SELECT 1 FROM "AAPIScore" a
                WHERE a."mom_id" = qp."momId" AND a."deleted_at" = 0 AND a."legacy_ps_id" IS NULL
                  AND (a."constructAPostAssessment" IS NOT NULL OR a."constructBPostAssessment" IS NOT NULL
                       OR a."constructCPostAssessment" IS NOT NULL OR a."constructDPostAssessment" IS NOT NULL
                       OR a."constructEPostAssessment" IS NOT NULL)
              )
              WHEN qp.track_group IN ('EP','RR') THEN EXISTS (
                SELECT 1 FROM "AssessmentResult" ar
                JOIN "Assessment" a ON a."id" = ar."assessmentId"
                WHERE ar."momId" = qp."momId" AND ar."deleted_at" = 0
                  AND ar."type"::text = 'post' AND a."name" NOT ILIKE '%Legacy%'
                  AND (
                    (qp.track_group = 'EP' AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%'))
                    OR (qp.track_group = 'RR' AND (a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%'))
                  )
              )
              ELSE FALSE
            END AS has_post
          FROM completed_only qp
        ),
        bucketed AS (
          SELECT
            CASE
              WHEN sc.track_held >= COALESCE(qp.required_track_sessions, 0) AND pa.has_post AND sc.support_held >= 1 THEN 'full_track'
              WHEN sc.track_held >= COALESCE(qp.required_track_sessions, 0) AND pa.has_post AND sc.support_held = 0 THEN 'without_support'
              WHEN NOT pa.has_post THEN 'without_post'
              ELSE 'other'
            END AS bucket
          FROM completed_only qp
          JOIN session_counts sc ON sc.pairing_id = qp.pairing_id
          JOIN post_assessment pa ON pa.pairing_id = qp.pairing_id
        )
        SELECT
          (SELECT COUNT(*)::int FROM q1_pairings WHERE complete_reason IS NOT NULL)   AS total_completions,
          (SELECT COUNT(*)::int FROM q1_pairings WHERE incomplete_reason IS NOT NULL) AS total_incompletes,
          (SELECT COUNT(*)::int FROM bucketed WHERE bucket = 'full_track')      AS completed_full_track,
          (SELECT COUNT(*)::int FROM bucketed WHERE bucket = 'without_post')    AS completed_without_post_assessment,
          (SELECT COUNT(*)::int FROM bucketed WHERE bucket = 'without_support') AS completed_without_support_sessions,
          (SELECT COUNT(*)::int FROM q1_pairings WHERE incomplete_reason = 'achieved_outcomes')   AS incomplete_achieved_outcomes,
          (SELECT COUNT(*)::int FROM q1_pairings WHERE incomplete_reason = 'extended_wait')       AS incomplete_extended_wait,
          (SELECT COUNT(*)::int FROM q1_pairings WHERE incomplete_reason = 'no_advocate')         AS incomplete_no_advocate,
          (SELECT COUNT(*)::int FROM q1_pairings WHERE incomplete_reason = 'priorities_shifted')  AS incomplete_priorities_shifted
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
              -- Q1 anchor on updated_at (RD 4/25/26): captures AAPI rows where
              -- the post was entered in Q1 even when the pre was filled earlier.
              -- Filtering on created_at missed ~96% of NPP completions because
              -- AAPIScore rows are typically created at intake (pre filled),
              -- then updated months later when post is logged.
              AND s."updated_at" >= '${PERIOD_START}'
              AND s."updated_at" <= '${PERIOD_END} 23:59:59'
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
      // RD 4/25/26: 'Self-Referred' agency-named rows are normalized into the
      // 'Self-Referral' bucket along with referral_type_c='self' moms — they're
      // the same thing, surface as one row.
      pool.query(`
        SELECT
          CASE
            WHEN a."name" IS NULL AND m."referral_type_c"::text = 'self' THEN 'Self-Referral'
            WHEN a."name" IS NULL AND m."referral_type_c"::text = 'internal' THEN 'Internal Referral'
            WHEN a."name" IS NULL THEN 'Not Recorded'
            WHEN a."name" ~ '^[0-9a-f]{8}-' THEN 'Not Recorded'
            WHEN LOWER(TRIM(a."name")) IN ('self-referral','self referral','self-referred','self referred','self') THEN 'Self-Referral'
            ELSE a."name"
          END AS referral_source,
          COUNT(*)::int AS referrals_received,
          SUM(CASE WHEN m."prospect_status"::text = 'engaged_in_program' THEN 1 ELSE 0 END)::int AS intakes_completed,
          SUM(CASE WHEN m."prospect_status"::text = 'did_not_engage_in_program' THEN 1 ELSE 0 END)::int AS did_not_engage,
          SUM(CASE WHEN m."prospect_status"::text IN ('prospect', 'prospect_intake_scheduled') THEN 1 ELSE 0 END)::int AS pending,
          -- Did Not Initiate (DNI): mom reached engaged_in_program but never had
          -- a held session on any pairing. Back-traces the Track Completions DNI
          -- cohort into referral-stage outcomes so accounting is consistent
          -- across this tab. Pairing/Session may be missing entirely (no record
          -- yet created for the mom), which still counts as DNI.
          SUM(CASE
            WHEN m."prospect_status"::text = 'engaged_in_program'
              AND NOT EXISTS (
                SELECT 1 FROM "Pairing" p
                JOIN "Session" s ON s."pairing_id" = p."id"
                WHERE p."momId" = m."id"
                  AND p."deleted_at" = 0
                  AND s."deleted_at" = 0
                  AND s."status"::text = 'Held'
              )
            THEN 1 ELSE 0 END)::int AS did_not_initiate
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
      // RD 4/25/26 (item #5 fix): Added ${affWhereUser} to all 5 sub-SELECTs.
      // Previously the Q1 activity numbers were always org-wide regardless of
      // the affiliate slicer. Diagnostic confirmed: org-wide returned 38/69/24
      // while Broward-scoped returned 8/8/8 — the report was always showing
      // the org-wide numbers because the SQL ignored the affiliate filter.
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
              ${affWhereUser}
          ) AS applications,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_sub_status"::text IN (
                'Training_Completed','Waiting_To_Be_Paired','Paired',
                'Pending_Final_Steps','Taking_A_Break'
              )
              AND u."created_at" >= '${PERIOD_START}'
              AND u."created_at" <= '${PERIOD_END} 23:59:59'
              ${affWhereUser}
          ) AS trained,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_sub_status"::text IN (
                'Training_Completed','Waiting_To_Be_Paired','Paired','Pending_Final_Steps'
              )
              AND u."created_at" >= '${PERIOD_START}'
              AND u."created_at" <= '${PERIOD_END} 23:59:59'
              ${affWhereUser}
          ) AS approved,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_status"::text = 'Active'
              AND u."updated_at" >= '${PERIOD_START}'
              AND u."updated_at" <= '${PERIOD_END} 23:59:59'
              ${affWhereUser}
          ) AS became_active,
          (SELECT COUNT(*)::int FROM "User" u
            WHERE u."deleted_at" = 0
              AND u."advocate_status"::text = 'Inactive'
              AND u."updated_at" >= '${PERIOD_START}'
              AND u."updated_at" <= '${PERIOD_END} 23:59:59'
              ${affWhereUser}
          ) AS became_inactive
      `, affParams),

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
      // (pairing.completed_on NOT the anchor per Cristina).
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
              -- Q1 anchor on updated_at (RD 4/25/26): captures AAPI rows where
              -- the post was entered in Q1 even when the pre was filled earlier.
              -- Filtering on created_at missed ~96% of NPP completions because
              -- AAPIScore rows are typically created at intake (pre filled),
              -- then updated months later when post is logged.
              AND s."updated_at" >= '${PERIOD_START}'
              AND s."updated_at" <= '${PERIOD_END} 23:59:59'
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

      // ─── Service Area: per-mom location data (RD 4/25/26 item 23) ──
      // Single query returns one row per active-during-period mom with raw
      // state, county text, and ZIP. Post-processing in JS:
      //   1. ZIP-derived county FIPS (via lib/zip-to-county.json) is PRIMARY
      //   2. Text county field is FALLBACK when ZIP is missing/unrecognized
      //   3. Aggregates feed both `geographic_distribution` (map) and
      //      `counties_served` (panel) so they reconcile to the same cohort
      // Cohort: same active-during-period (paired pairing overlapping Q1)
      // as familiesServed. Replaces 2 prior county-aggregated queries.
      pool.query(`
        SELECT DISTINCT
          m."id",
          NULLIF(TRIM(m."primary_address_state"), '')      AS state_name,
          NULLIF(TRIM(m."primary_address_county_c"), '')   AS county_name,
          NULLIF(TRIM(m."primary_address_postalcode"), '') AS zip
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
      `, affParams),

      // ─── Top ZIP Codes (Service Area panel) ──────────────────
      // Aggregates moms by ZIP + city. Post-processing applies privacy floor
      // (ZIPs with <5 moms rolled into "Other ZIPs"), takes top 5, then rolls
      // remaining into "Other ZIPs" too. Same active-during-period cohort.
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(m."primary_address_postalcode"), ''), 'Unknown') AS zip,
          COALESCE(NULLIF(TRIM(m."primary_address_city"), ''), '') AS city,
          COUNT(DISTINCT m."id")::int AS count
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          AND m."primary_address_postalcode" IS NOT NULL
          AND TRIM(m."primary_address_postalcode") != ''
          ${affWhere}
        GROUP BY 1, 2
        ORDER BY 3 DESC
      `, affParams),

      // ─── Demographics: Race distribution ─────────────────────
      // GROUP BY raw race_c. Display labels match what's in the database.
      // Same active-during-period cohort as familiesServed.
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(m."race_c"), ''), 'Unknown') AS race,
          COUNT(DISTINCT m."id")::int AS count
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
        GROUP BY 1
        ORDER BY 2 DESC
      `, affParams),

      // ─── Demographics: Age distribution ──────────────────────
      // Buckets computed from Mom.birthdate as of PERIOD_END (so the report
      // is anchored to "age during Q1" not viewer time).
      // ORDER BY uses MIN(age_yrs) — Postgres doesn't accept the output alias
      // 'bucket' as the operand of CASE in ORDER BY, so we use the natural
      // numeric ordering of the youngest age in each bucket instead.
      pool.query(`
        SELECT
          CASE
            WHEN age_yrs < 18 THEN 'Under 18'
            WHEN age_yrs < 25 THEN '18 to 24'
            WHEN age_yrs < 35 THEN '25 to 34'
            WHEN age_yrs < 45 THEN '35 to 44'
            ELSE '45+'
          END AS bucket,
          COUNT(*)::int AS count
        FROM (
          SELECT m."id",
            DATE_PART('year', AGE('${PERIOD_END}'::date, m."birthdate"))::int AS age_yrs
          FROM "Mom" m
          JOIN "Pairing" p ON p."momId" = m."id"
          WHERE m."deleted_at" = 0
            AND p."deleted_at" = 0
            AND p."status"::text = 'paired'
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            AND m."birthdate" IS NOT NULL
            ${affWhere}
          GROUP BY m."id", m."birthdate"
        ) ages
        GROUP BY 1
        ORDER BY MIN(age_yrs)
      `, affParams),

      // ─── Demographics: Top languages spoken ──────────────────
      // languages_c is an ARRAY of Language enum (USER-DEFINED type), not text.
      // UNNEST returns the enum value; we ::text-cast inside the subquery so
      // outer TRIM() / GROUP BY / display all work on plain strings.
      pool.query(`
        SELECT lang, COUNT(DISTINCT mom_id)::int AS count
        FROM (
          SELECT m."id" AS mom_id, UNNEST(m."languages_c")::text AS lang
          FROM "Mom" m
          JOIN "Pairing" p ON p."momId" = m."id"
          WHERE m."deleted_at" = 0
            AND p."deleted_at" = 0
            AND p."status"::text = 'paired'
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            AND m."languages_c" IS NOT NULL
            AND array_length(m."languages_c", 1) > 0
            ${affWhere}
        ) lc
        WHERE lang IS NOT NULL AND TRIM(lang) != ''
        GROUP BY lang
        ORDER BY 2 DESC
      `, affParams),

      // ─── Demographics: Pregnancy at intake ───────────────────
      // currently_pregnant_c is text. Values normalized in post-processing.
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(m."currently_pregnant_c"), ''), 'Unknown') AS status,
          COUNT(DISTINCT m."id")::int AS count
        FROM "Mom" m
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
        GROUP BY 1
        ORDER BY 2 DESC
      `, affParams),

      // ─── Demographics: Children in home buckets ──────────────
      // Count children per Mom in the active-during-period cohort. Bucket as
      // 0 / 1 / 2 / 3 / 4+. Moms with no Child rows count toward the "0" bucket.
      pool.query(`
        SELECT bucket, COUNT(*)::int AS count
        FROM (
          SELECT m."id",
            CASE
              WHEN COUNT(c."id") = 0 THEN '0'
              WHEN COUNT(c."id") = 1 THEN '1'
              WHEN COUNT(c."id") = 2 THEN '2'
              WHEN COUNT(c."id") = 3 THEN '3'
              ELSE '4 or more'
            END AS bucket
          FROM "Mom" m
          JOIN "Pairing" p ON p."momId" = m."id"
          LEFT JOIN "Child" c ON c."mom_id" = m."id" AND c."deleted_at" = 0
          WHERE m."deleted_at" = 0
            AND p."deleted_at" = 0
            AND p."status"::text = 'paired'
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            ${affWhere}
          GROUP BY m."id"
        ) per_mom
        GROUP BY bucket
        ORDER BY CASE bucket
          WHEN '0' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2 WHEN '3' THEN 3
          ELSE 4 END
      `, affParams),

      // ─── Demographics: Avg age of children + total ──────────
      // Uses to_jsonb probe on the Child table — returns NULL if 'birthdate'
      // doesn't exist as a column rather than erroring. Same pattern is
      // safe for any other unknown column name we might want to try later.
      pool.query(`
        SELECT
          COUNT(c."id")::int AS total_kids,
          AVG(
            CASE
              WHEN (to_jsonb(c.*) ->> 'birthdate') IS NOT NULL
              THEN DATE_PART('year', AGE('${PERIOD_END}'::date, (to_jsonb(c.*) ->> 'birthdate')::date))
              ELSE NULL
            END
          )::float AS avg_age_yrs
        FROM "Child" c
        JOIN "Mom" m ON m."id" = c."mom_id"
        JOIN "Pairing" p ON p."momId" = m."id"
        WHERE c."deleted_at" = 0
          AND m."deleted_at" = 0
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."created_at" <= '${PERIOD_END} 23:59:59'
          AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
          ${affWhere}
      `, affParams),

      // ─── Demographics: Caregiver type ───────────────────────
      // Trellis custom-field column name unknown — probe via to_jsonb so we
      // don't blow up if the column doesn't exist. We try several plausible
      // names; the first non-null wins per mom. Empty/Unknown rows are
      // dropped so the panel shows only recorded responses.
      pool.query(`
        SELECT raw_value AS caregiver, COUNT(DISTINCT mom_id)::int AS count
        FROM (
          SELECT m."id" AS mom_id,
            COALESCE(
              NULLIF(TRIM(to_jsonb(m.*) ->> 'caregiver_type_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'caregiver_role_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'caregiver_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'mom_type_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'parent_type_c'), '')
            ) AS raw_value
          FROM "Mom" m
          JOIN "Pairing" p ON p."momId" = m."id"
          WHERE m."deleted_at" = 0
            AND p."deleted_at" = 0
            AND p."status"::text = 'paired'
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            ${affWhere}
        ) probed
        WHERE raw_value IS NOT NULL
        GROUP BY raw_value
        ORDER BY 2 DESC
      `, affParams),

      // ─── Demographics: Marital status ───────────────────────
      // Same to_jsonb probe pattern. Trellis-style names tried first.
      pool.query(`
        SELECT raw_value AS marital, COUNT(DISTINCT mom_id)::int AS count
        FROM (
          SELECT m."id" AS mom_id,
            COALESCE(
              NULLIF(TRIM(to_jsonb(m.*) ->> 'marital_status_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'marital_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'relationship_status_c'), ''),
              NULLIF(TRIM(to_jsonb(m.*) ->> 'partner_status_c'), '')
            ) AS raw_value
          FROM "Mom" m
          JOIN "Pairing" p ON p."momId" = m."id"
          WHERE m."deleted_at" = 0
            AND p."deleted_at" = 0
            AND p."status"::text = 'paired'
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" >= '${PERIOD_START}')
            ${affWhere}
        ) probed
        WHERE raw_value IS NOT NULL
        GROUP BY raw_value
        ORDER BY 2 DESC
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

    // ─── Service Area: per-mom location → FIPS resolution (RD v3) ─
    // For each active-during-period mom, derive (state_fips, county_fips)
    // using a 3-tier resolution strategy:
    //   1. ZIP → county FIPS via lib/zip-to-county.json (PRIMARY)
    //      Most reliable — ZIPs are entered consistently and one ZIP
    //      maps to one canonical county. Works nationwide.
    //   2. Text county field via normalizeCountyName + COUNTY_FIPS lookup
    //      (FALLBACK when ZIP missing/unrecognized)
    //   3. State only (county_fips = null) when state recognized but
    //      neither ZIP nor county text resolves — keeps the mom on the
    //      map at state level even without county detail.
    // Aggregates feed BOTH outputs (geographic_distribution + counties_served)
    // so they reconcile to the same cohort.
    const momLocations = [];
    let geoUnmapped = 0;
    let resolvedByZip = 0;
    for (const r of (momLocationsRaw.rows || [])) {
      const stateKey = normalizeName(r.state_name);
      const stateFips = STATE_FIPS[stateKey];
      if (!stateFips) { geoUnmapped++; continue; }
      // ZIP-derived county FIPS only (RD 4/30/26): the text county field
      // (m.primary_address_county_c) is unreliable — coordinators enter free
      // text with inconsistent capitalization, abbreviations, and sometimes
      // the wrong county for the ZIP. Deriving county from ZIP via the
      // Census ZCTA crosswalk is the source of truth, and it makes the
      // Counties Served panel reconcile cleanly with the Top ZIPs panel
      // (every mom in a ZIP appears in the same county). Moms without a
      // resolvable ZIP fall into the 'Unknown' bucket.
      const countyFips = lookupZipCounty(r.zip);
      if (countyFips) resolvedByZip++;
      momLocations.push({ stateFips, countyFips });
    }
    if (geoUnmapped > 0) {
      console.log(`[geo] ${geoUnmapped} moms dropped from map (state not recognized)`);
    }
    console.log(`[geo] resolved: ${resolvedByZip} via ZIP, ${momLocations.length - resolvedByZip} unresolved (no/invalid ZIP)`);

    // Aggregate for the map (geographic_distribution): one row per county
    // (or per state-only when county isn't resolved). Frontend's renderGeoMap
    // auto-switches to state view when >2 distinct states present.
    const geoByKey = {};
    for (const loc of momLocations) {
      const k = loc.countyFips || ('STATE-' + loc.stateFips);
      if (!geoByKey[k]) geoByKey[k] = { state_fips: loc.stateFips, county_fips: loc.countyFips, count: 0 };
      geoByKey[k].count++;
    }
    const geographicDistribution = Object.values(geoByKey);

    // Aggregate for the Counties Served panel: top 5 by count + Other rollup.
    // Display name comes from COUNTY_NAME_BY_FIPS (canonical), with 'Unknown'
    // bucket for moms whose county couldn't be resolved.
    const countyBuckets = {};
    for (const loc of momLocations) {
      const name = loc.countyFips
        ? (COUNTY_NAME_BY_FIPS[loc.countyFips] || loc.countyFips)
        : 'Unknown';
      countyBuckets[name] = (countyBuckets[name] || 0) + 1;
    }
    const countiesNormalized = Object.entries(countyBuckets)
      .map(([name, count]) => ({ county_name: name, count }))
      .sort((a, b) => b.count - a.count);
    const countiesTotalAll = countiesNormalized.reduce((s, r) => s + r.count, 0);
    const countiesTop = countiesNormalized.slice(0, 5);
    const countiesRest = countiesNormalized.slice(5);
    const countiesOtherCount = countiesRest.reduce((s, r) => s + r.count, 0);
    const countiesServed = countiesTop.map((r) => ({
      name: r.county_name,
      count: r.count,
      pct: countiesTotalAll > 0 ? Math.round(1000 * r.count / countiesTotalAll) / 10 : 0,
    }));
    if (countiesOtherCount > 0) {
      countiesServed.push({
        name: 'Other Counties',
        count: countiesOtherCount,
        pct: countiesTotalAll > 0 ? Math.round(1000 * countiesOtherCount / countiesTotalAll) / 10 : 0,
        is_other: true,
      });
    }

    // ─── Top ZIP Codes: top 5 + "Other ZIPs" rollup, plus full list ──
    // Privacy floor dropped (RD 4/24/26) — for internal HQ admin oversight,
    // surfacing low-count ZIPs is acceptable and the panel was useless when
    // small affiliates had nothing above a 5-mom threshold. Re-add a floor
    // before any external publishing of this data.
    // V2 (RD 4/25/26): Also expose top_zip_codes_full so the frontend can offer
    // a "show all" toggle that expands beyond the top-5 default view.
    // Combine all rows with the same ZIP regardless of city spelling
    // (RD 4/30/26): the SQL groups by (zip, city), so a single ZIP with
    // multiple free-text city variants (Ft. Lauderdale / Fort Lauderdale,
    // Lauderhill / Lauderhill FL, etc.) shows up as duplicate rows. Roll
    // them up to one row per ZIP and pick a canonical city — most common
    // wins, alphabetical break for ties.
    const zipMap = {};
    for (const r of (topZipCodesRaw.rows || [])) {
      if (!r.zip || r.zip === 'Unknown') continue;
      if (!zipMap[r.zip]) zipMap[r.zip] = { zip: r.zip, count: 0, cityVotes: {} };
      zipMap[r.zip].count += r.count;
      const cityClean = (r.city || '').trim();
      if (cityClean) {
        zipMap[r.zip].cityVotes[cityClean] = (zipMap[r.zip].cityVotes[cityClean] || 0) + r.count;
      }
    }
    const zipsRowsAll = Object.values(zipMap).map((z) => {
      const ranked = Object.entries(z.cityVotes)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { zip: z.zip, city: ranked[0]?.[0] || '', count: z.count };
    }).sort((a, b) => b.count - a.count || a.zip.localeCompare(b.zip));
    const zipsTop = zipsRowsAll.slice(0, 5);
    const zipsRest = zipsRowsAll.slice(5);
    const zipsOtherCount = zipsRest.reduce((s, r) => s + r.count, 0);
    const topZipCodes = zipsTop.map((r) => ({
      zip: r.zip,
      city: r.city || '',
      count: r.count,
    }));
    if (zipsOtherCount > 0) {
      topZipCodes.push({ zip: 'OTHER', city: 'Other ZIPs combined', count: zipsOtherCount, is_other: true });
    }
    // Full list (all ZIPs, no rollup, sorted DESC by count) for the expand toggle.
    const topZipCodesFull = zipsRowsAll.map((r) => ({
      zip: r.zip,
      city: r.city || '',
      count: r.count,
    }));

    // ─── Demographics post-processing ────────────────────────
    // Race: keep raw labels (top 5 + "Other Races" rollup).
    const raceRows = (raceDistRaw.rows || []);
    const raceTotal = raceRows.reduce((s, r) => s + r.count, 0);
    const raceTop = raceRows.slice(0, 5);
    const raceRest = raceRows.slice(5);
    const raceOtherCount = raceRest.reduce((s, r) => s + r.count, 0);
    const raceDistribution = raceTop.map((r) => ({
      label: r.race,
      count: r.count,
      pct: raceTotal > 0 ? Math.round(1000 * r.count / raceTotal) / 10 : 0,
    }));
    if (raceOtherCount > 0) {
      raceDistribution.push({
        label: 'Other Races',
        count: raceOtherCount,
        pct: raceTotal > 0 ? Math.round(1000 * raceOtherCount / raceTotal) / 10 : 0,
        is_other: true,
      });
    }

    // Age: already bucketed in SQL with stable ordering.
    const ageRows = (ageDistRaw.rows || []);
    const ageTotal = ageRows.reduce((s, r) => s + r.count, 0);
    const ageDistribution = ageRows.map((r) => ({
      label: r.bucket,
      count: r.count,
      pct: ageTotal > 0 ? Math.round(1000 * r.count / ageTotal) / 10 : 0,
    }));

    // Languages: top 5 by count. Note: each mom can speak multiple, so the
    // sum of percentages can exceed 100% — that's expected.
    const langRows = (languageDistRaw.rows || []);
    // Denominator for % display = distinct moms with ANY language recorded.
    const langDistinctMoms = langRows.length > 0 ? Math.max(...langRows.map((r) => r.count)) : 0;
    // Better: count distinct moms separately. Use the highest-count language
    // as a lower bound; for a true denom we'd need a separate query. For now,
    // use raceTotal-equivalent (active-during-period cohort) — assumes most
    // active moms have at least one language recorded. Frontend can override.
    const languageDistribution = langRows.slice(0, 5).map((r) => ({
      label: r.lang,
      count: r.count,
      pct: langDistinctMoms > 0 ? Math.round(1000 * r.count / langDistinctMoms) / 10 : 0,
    }));

    // Pregnancy: normalize 'Yes'/'No'/'true'/'false' style values into
    // 'Pregnant at intake' vs 'Not pregnant at intake'.
    const pregRows = (pregnancyDistRaw.rows || []);
    let pregYes = 0, pregNo = 0, pregUnknown = 0;
    for (const r of pregRows) {
      const v = String(r.status || '').trim().toLowerCase();
      if (v === 'yes' || v === 'true' || v === 'currently pregnant' || v === 'pregnant') pregYes += r.count;
      else if (v === 'no' || v === 'false' || v === 'not pregnant' || v === 'not pregnant at intake') pregNo += r.count;
      else pregUnknown += r.count;
    }
    const pregTotal = pregYes + pregNo;  // Unknown excluded from rate
    const pregnancyDistribution = [
      { label: 'Not pregnant at intake', count: pregNo, pct: pregTotal > 0 ? Math.round(1000 * pregNo / pregTotal) / 10 : 0 },
      { label: 'Pregnant at intake',     count: pregYes, pct: pregTotal > 0 ? Math.round(1000 * pregYes / pregTotal) / 10 : 0 },
    ];

    // Children in home: SQL emits the canonical buckets in order.
    const kidsRows = (childrenInHomeRaw.rows || []);
    const kidsTotalMoms = kidsRows.reduce((s, r) => s + r.count, 0);
    const childrenInHome = kidsRows.map((r) => ({
      label: r.bucket,
      count: r.count,
      pct: kidsTotalMoms > 0 ? Math.round(1000 * r.count / kidsTotalMoms) / 10 : 0,
    }));
    const kidsAvgAgeRow = (childrenAvgAgeRaw.rows || [])[0] || {};
    const kidsTotalChildren = kidsAvgAgeRow.total_kids || 0;
    const kidsAvgAge = kidsAvgAgeRow.avg_age_yrs != null
      ? Math.round(kidsAvgAgeRow.avg_age_yrs * 10) / 10
      : null;

    // Caregiver / Marital — light-touch label normalization. Raw enum values
    // are usually snake_case ('biological_mom', 'foster_mom'); humanize them.
    function humanizeEnum(v) {
      if (!v) return v;
      return String(v).replace(/_/g, ' ')
        .replace(/\s+/g, ' ').trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
        // common touch-ups
        .replace(/\bMom\b/g, 'mom')
        .replace(/\bGuardian\b/g, 'guardian')
        .replace(/^./, (ch) => ch.toUpperCase());
    }
    const careRows = (caregiverDistRaw.rows || []);
    const careTotal = careRows.reduce((s, r) => s + r.count, 0);
    const caregiverDistribution = careRows.map((r) => ({
      label: humanizeEnum(r.caregiver),
      count: r.count,
      pct: careTotal > 0 ? Math.round(1000 * r.count / careTotal) / 10 : 0,
    }));
    const marRows = (maritalDistRaw.rows || []);
    const marTotal = marRows.reduce((s, r) => s + r.count, 0);
    const maritalDistribution = marRows.map((r) => ({
      label: humanizeEnum(r.marital),
      count: r.count,
      pct: marTotal > 0 ? Math.round(1000 * r.count / marTotal) / 10 : 0,
    }));

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
      // children_total (RD 4/25/26 item 9): solid count for moms WITH child records
      // PLUS the assumed average applied to moms without records. This proxies
      // children-served for moms whose kids haven't been entered into Trellis yet.
      // Frontend can read the unprojected count via children_actual if needed.
      snapshot: (() => {
        const actual = childrenCount.rows[0].total;
        const avg = avgChildren.rows[0]?.avg_children || 0;
        const noRecords = momsNoChildren.rows[0].count;
        const projected = Math.round(actual + (avg * noRecords));
        return {
        families_served: familiesServed.rows[0].count,
        active_advocates: advocateCount.rows[0].count,
        children_total: projected,
        children_actual: actual,
        children_proxy_added: projected - actual,
        moms_with_children: childrenCount.rows[0].moms_with_children,
        avg_children_per_mom: avg,
        moms_no_child_records: noRecords,
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
        };
      })(),

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

      // Counties Served panel — top 5 by mom count + "Other Counties" rollup.
      // Shape: [{ name, count, pct, is_other? }, ...]
      counties_served: countiesServed,

      // Top ZIP Codes panel — top 5 + "Other ZIPs" rollup (default view).
      // Shape: [{ zip, city, count, is_other? }, ...]
      top_zip_codes: topZipCodes,
      // Full list of all ZIPs (no rollup) — drives the "Show all" expand toggle.
      // Shape: [{ zip, city, count }, ...] sorted DESC.
      top_zip_codes_full: topZipCodesFull,

      // Demographics tab — Race / Age / Language / Pregnancy distributions.
      // All scoped to the active-during-period cohort (same as familiesServed).
      // Each: [{ label, count, pct, is_other? }, ...]
      demographics: {
        race: raceDistribution,
        age: ageDistribution,
        languages: languageDistribution,
        pregnancy: pregnancyDistribution,
        children_in_home: childrenInHome,
        children_total: kidsTotalChildren,
        children_avg_age: kidsAvgAge,
        children_moms_n: kidsTotalMoms,
        caregiver: caregiverDistribution,
        caregiver_n: careTotal,
        marital: maritalDistribution,
        marital_n: marTotal,
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
