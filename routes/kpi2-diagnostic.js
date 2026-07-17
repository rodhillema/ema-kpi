/* ============================================================
   /api/kpi2-diagnostic
   KPI 2 Financial/Family Wellness Diagnostic — data capture,
   scoring method, and assessment design audit.
   Administrator only. Q2 YTD: Jan 1 – Jun 30, 2026.
   ============================================================ */

'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const DATA_START = '2026-01-01';
const DATA_END   = '2026-06-30';

const DOMAINS = ['ats','cc','edu','ei','fin','home','naa','res','soc','trnprt','well'];

const DOMAIN_LABELS = {
  ats:    'Access to Services',
  cc:     'Child Care & Wellness',
  edu:    'Education',
  ei:     'Employment & Income',
  fin:    'Financial',
  home:   'Housing',
  naa:    'Nurturing & Attachment',
  res:    'Resilience',
  soc:    'Social Support',
  trnprt: 'Transportation',
  well:   'Wellness',
};

const DOMAIN_COLS = {
  ats:    'ats_score',
  cc:     'cc_score',
  edu:    'edu_score',
  ei:     'ei_score',
  fin:    'fin_cpi_sum',
  home:   'home_score',
  naa:    'naa_score',
  res:    'res_score',
  soc:    'soc_score',
  trnprt: 'trnprt_score',
  well:   'well_score',
};

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'administrator') return next();
  return res.status(403).json({ error: 'Access denied' });
}

// Mirrors production INTAKE_CTE from report-data.js / kpi2-trial.js
const PS_BATCH_CTE = `
  ps_batch AS (
    SELECT DISTINCT data->>'id' AS mom_id
    FROM "AuditLog"
    WHERE "table" = 'Mom' AND action = 'Update'
      AND data->>'prospect_status' = 'engaged_in_program'
      AND DATE_TRUNC('day', created_at) IN ('2025-11-30'::date, '2025-12-17'::date)
  )`;

const INTAKE_CTES = `
  first_engaged AS (
    SELECT data->>'id' AS mom_id, MIN(created_at) AS coordinator_engaged_date
    FROM "AuditLog"
    WHERE "table" = 'Mom' AND action = 'Update'
      AND data->>'prospect_status' = 'engaged_in_program'
    GROUP BY data->>'id'
  ),
  organic_only AS (
    SELECT * FROM first_engaged
    WHERE DATE_TRUNC('day', coordinator_engaged_date)
      NOT IN ('2025-11-30'::date, '2025-12-17'::date)
  ),
  fwa_link AS (
    SELECT DISTINCT ON ("mom_id") "mom_id", "completed_ahead", "completed_date"
    FROM "WellnessAssessment"
    WHERE "deleted_at" = 0
    ORDER BY "mom_id", "created_at" ASC
  ),
  intake_dates AS (
    SELECT oo.mom_id,
      CASE WHEN fl."completed_ahead" = true AND fl."completed_date" IS NOT NULL
           THEN fl."completed_date"
           ELSE oo.coordinator_engaged_date END AS intake_date
    FROM organic_only oo
    LEFT JOIN fwa_link fl ON fl."mom_id"::text = oo.mom_id
  )`;

const STRICT_COHORT_CTE = (dataStart, dataEnd) => `
  strict_kpi2_cohort AS (
    SELECT DISTINCT p."momId"::text AS mom_id
    FROM "Pairing" p
    JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
    LEFT JOIN ps_batch pb ON pb.mom_id = m."id"::text
    WHERE p."deleted_at" = 0
      AND p."created_at" <= '${dataEnd} 23:59:59'
      AND (p."completed_on" IS NULL OR p."completed_on" > '${dataStart}')
      AND pb.mom_id IS NULL
  )`;

// Pre-FWA domain columns fragment (reused in multiple CTEs)
const PRE_COLS = DOMAINS.map(d => `    COALESCE(w."${DOMAIN_COLS[d]}",0)::numeric AS ${d}`).join(',\n');
const POST_COLS = DOMAINS.map(d => `    COALESCE(w."${DOMAIN_COLS[d]}",0)::numeric AS post_${d}`).join(',\n');

// Sum expression for FSS composite
const PRE_SUM  = DOMAINS.map(d => `p.${d}`).join('+');
const POST_SUM = DOMAINS.map(d => `q.post_${d}`).join('+');

// Count of domains where post > pre
const DOMAINS_UP = DOMAINS.map(d => `(q.post_${d}>p.${d})::int`).join('+');

// Question-level freeze analysis: for paired cohort, compare each question column pre vs post.
// Returns per-question same/changed counts, grouped by domain.
async function runQFreezeAnalysis(pool, PS_BATCH_CTE, INTAKE_CTES) {
  // Step 1: get all question-level columns (exclude score totals and metadata)
  const SCORE_COLS = new Set([
    'ats_score','cc_score','edu_score','ei_score','fin_cpi_sum','home_score',
    'naa_score','res_score','soc_score','trnprt_score','well_score',
    'cpi_total','well_phq_total','well_gad_total',
    'fin_lmi','fin_ami',
  ]);
  const colRes = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'WellnessAssessment'
      AND column_name ~ '^(ats|cc|edu|ei|fin|home|naa|res|soc|trnprt|well)_'
    ORDER BY column_name
  `);
  const qCols = colRes.rows.map(r => r.column_name).filter(c => !SCORE_COLS.has(c));
  if (!qCols.length) return { error: 'no question columns found', rows: [] };

  const domainOfCol = c => c.split('_')[0];

  // Step 2: build dynamic freeze query
  const preSelects  = qCols.map(c => `w."${c}" AS ${c}`).join(', ');
  const postSelects = qCols.map(c => `w."${c}" AS ${c}`).join(', ');
  const sameExprs   = qCols.map(c =>
    `SUM((pre."${c}" IS NOT DISTINCT FROM post."${c}")::int) AS "${c}_same",` +
    `SUM((pre."${c}" IS NOT NULL OR post."${c}" IS NOT NULL)::int) AS "${c}_answered"`
  ).join(',\n        ');

  const sql = `
    WITH
    ${PS_BATCH_CTE},
    ${INTAKE_CTES},
    pre_fwa AS (
      SELECT DISTINCT ON (w."mom_id")
        w."mom_id"::text AS mom_id,
        ${preSelects}
      FROM "WellnessAssessment" w
      JOIN intake_dates id ON id.mom_id = w."mom_id"::text
      WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
      ORDER BY w."mom_id", w."created_at" ASC
    ),
    post_fwa AS (
      SELECT DISTINCT ON (w."mom_id")
        w."mom_id"::text AS mom_id,
        ${postSelects}
      FROM "WellnessAssessment" w
      JOIN intake_dates id ON id.mom_id = w."mom_id"::text
      WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
        AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
        AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
      ORDER BY w."mom_id", w."updated_at" DESC
    )
    SELECT
      COUNT(*) AS paired_n,
      ${sameExprs}
    FROM pre_fwa pre
    JOIN post_fwa post ON post.mom_id = pre.mom_id
  `;

  const { rows } = await pool.query(sql);
  const agg = rows[0] || {};
  const paired_n = parseInt(agg.paired_n) || 0;

  // Reshape into per-question objects, then group by domain
  const questions = qCols.map(c => {
    const same_n     = parseInt(agg[`${c}_same`]) || 0;
    const answered_n = parseInt(agg[`${c}_answered`]) || 0;
    const changed_n  = answered_n - same_n;
    return {
      col:        c,
      domain:     domainOfCol(c),
      same_n,
      changed_n,
      answered_n,
      pct_frozen: answered_n > 0 ? Math.round(100 * same_n / answered_n) : null,
    };
  });

  const byDomain = {};
  for (const q of questions) {
    if (!byDomain[q.domain]) byDomain[q.domain] = { domain: q.domain, questions: [], total_same: 0, total_changed: 0, total_answered: 0 };
    byDomain[q.domain].questions.push(q);
    byDomain[q.domain].total_same     += q.same_n;
    byDomain[q.domain].total_changed  += q.changed_n;
    byDomain[q.domain].total_answered += q.answered_n;
  }
  for (const d of Object.values(byDomain)) {
    d.pct_frozen = d.total_answered > 0 ? Math.round(100 * d.total_same / d.total_answered) : null;
  }

  return { paired_n, questions, byDomain };
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [pairedResult, gapResult, affResult, distResult, mainKpiResult] = await Promise.all([

      // ── Q1: Paired rows — moms with both pre + post FWA in the 91-180 day window ──
      pool.query(`
        WITH
        ${PS_BATCH_CTE},
        ${INTAKE_CTES},
        ${STRICT_COHORT_CTE(DATA_START, DATA_END)},
        pre_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text AS mom_id,
            w."created_at"   AS pre_date,
            w."completed_ahead" AS pre_link_sent,
${PRE_COLS}
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
          ORDER BY w."mom_id", w."created_at" ASC
        ),
        post_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text AS mom_id,
            w."updated_at"   AS post_date,
            w."completed_ahead" AS post_link_sent,
${POST_COLS}
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
            AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
          ORDER BY w."mom_id", w."updated_at" DESC
        )
        SELECT
          p.mom_id,
          m."first_name",
          m."last_name",
          COALESCE(aff."name", 'Unknown') AS affiliate_name,
          CASE WHEN s.mom_id IS NOT NULL THEN 1 ELSE 0 END AS strict_kpi2,
          id.intake_date::date,
          p.pre_date::date,
          q.post_date::date,
          (q.post_date::date - p.pre_date::date) AS days_between,
          CASE WHEN q.post_date < p.pre_date THEN 1 ELSE 0 END AS temporal_inversion,
          p.pre_link_sent  AS intake_link_sent,
          q.post_link_sent AS sixmo_link_sent,
          -- FSS composite
          (${PRE_SUM})  AS pre_fss,
          (${POST_SUM}) AS post_fss,
          (${POST_SUM}) - (${PRE_SUM}) AS fss_delta,
          CASE WHEN (${POST_SUM}) > (${PRE_SUM}) THEN 1 ELSE 0 END AS fss_improved,
          -- Per-domain pre scores
          ${DOMAINS.map(d => `p.${d} AS pre_${d}`).join(', ')},
          -- Per-domain post scores
          ${DOMAINS.map(d => `q.post_${d}`).join(', ')},
          -- Per-domain improvement flags
          ${DOMAINS.map(d => `(q.post_${d}>p.${d})::int AS ${d}_up`).join(', ')},
          -- Domain summary counts
          (${DOMAINS_UP}) AS domains_improved_count,
          CASE WHEN (${DOMAINS_UP}) >= 1 THEN 1 ELSE 0 END AS any_domain_improved,
          -- Flip: FSS composite did NOT improve but at least one domain did
          CASE WHEN (${POST_SUM}) <= (${PRE_SUM})
            AND (${DOMAINS_UP}) >= 1 THEN 1 ELSE 0 END AS fss_vs_anydomain_flip
        FROM pre_fwa p
        JOIN post_fwa q ON q.mom_id = p.mom_id
        JOIN intake_dates id ON id.mom_id = p.mom_id
        JOIN "Mom" m ON m."id"::text = p.mom_id AND m."deleted_at" = 0
        LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
        LEFT JOIN strict_kpi2_cohort s ON s.mom_id = p.mom_id
        ORDER BY strict_kpi2 DESC, fss_delta DESC
      `),

      // ── Q2: Gap analysis funnel counts ──
      pool.query(`
        WITH
        ${PS_BATCH_CTE},
        ${INTAKE_CTES},
        pre_fwa_ids AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id,
            MIN(w."created_at") AS pre_date
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
          GROUP BY w."mom_id"
        ),
        post_in_window AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
            AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
        ),
        next_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text AS mom_id,
            w."updated_at"   AS next_date,
            EXTRACT(EPOCH FROM (w."updated_at" - id.intake_date))::int / 86400 AS days_from_intake
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          JOIN pre_fwa_ids pf ON pf.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."created_at" > pf.pre_date
          ORDER BY w."mom_id", w."created_at" ASC
        )
        SELECT
          (SELECT COUNT(*)::int FROM intake_dates)                   AS total_organic,
          (SELECT COUNT(*)::int FROM ps_batch)                       AS ps_migrated_n,
          (SELECT COUNT(*)::int FROM pre_fwa_ids)                    AS has_pre_n,
          (SELECT COUNT(*)::int FROM post_in_window)                 AS has_post_in_window_n,
          -- pre but no post in window — sub-categorize why
          (SELECT COUNT(*)::int FROM pre_fwa_ids pf
             WHERE NOT EXISTS (SELECT 1 FROM post_in_window pw WHERE pw.mom_id = pf.mom_id)
             AND NOT EXISTS (SELECT 1 FROM next_fwa nf WHERE nf.mom_id = pf.mom_id))
                                                                     AS no_second_fwa_n,
          (SELECT COUNT(*)::int FROM pre_fwa_ids pf
             JOIN next_fwa nf ON nf.mom_id = pf.mom_id
             WHERE NOT EXISTS (SELECT 1 FROM post_in_window pw WHERE pw.mom_id = pf.mom_id)
             AND nf.days_from_intake < 91)                           AS post_too_early_n,
          (SELECT COUNT(*)::int FROM pre_fwa_ids pf
             JOIN next_fwa nf ON nf.mom_id = pf.mom_id
             WHERE NOT EXISTS (SELECT 1 FROM post_in_window pw WHERE pw.mom_id = pf.mom_id)
             AND nf.days_from_intake > 180)                          AS post_too_late_n,
          (SELECT COUNT(*)::int
             FROM intake_dates id
             WHERE NOT EXISTS (SELECT 1 FROM pre_fwa_ids pf WHERE pf.mom_id = id.mom_id))
                                                                     AS no_pre_n
      `),

      // ── Q3: Per-affiliate funnel with gap breakdown ──
      pool.query(`
        WITH
        ${PS_BATCH_CTE},
        ${INTAKE_CTES},
        intake_fwa_ids AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id,
            MIN(w."created_at") AS intake_fwa_date
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
          GROUP BY w."mom_id"
        ),
        sixmo_fwa AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
            AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
        ),
        next_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text AS mom_id,
            EXTRACT(EPOCH FROM (w."updated_at" - id.intake_date))::int / 86400 AS days_from_intake
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          JOIN intake_fwa_ids pf ON pf.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."created_at" > pf.intake_fwa_date
          ORDER BY w."mom_id", w."created_at" ASC
        )
        SELECT
          COALESCE(aff."name", 'Unknown') AS affiliate_name,
          COUNT(DISTINCT id.mom_id)::int  AS total_n,
          COUNT(DISTINCT pf.mom_id)::int  AS has_intake_fwa_n,
          COUNT(DISTINCT sw.mom_id)::int  AS has_sixmo_fwa_n,
          -- Gap sub-categories (moms with intake FWA but no 6-month FWA)
          COUNT(DISTINCT CASE
            WHEN pf.mom_id IS NOT NULL AND sw.mom_id IS NULL AND nf.mom_id IS NULL
            THEN id.mom_id END)::int AS no_followup_n,
          COUNT(DISTINCT CASE
            WHEN pf.mom_id IS NOT NULL AND sw.mom_id IS NULL AND nf.mom_id IS NOT NULL AND nf.days_from_intake < 91
            THEN id.mom_id END)::int AS has_3mo_only_n,
          COUNT(DISTINCT CASE
            WHEN pf.mom_id IS NOT NULL AND sw.mom_id IS NULL AND nf.mom_id IS NOT NULL AND nf.days_from_intake > 180
            THEN id.mom_id END)::int AS post_window_n
        FROM intake_dates id
        JOIN "Mom" m ON m."id"::text = id.mom_id AND m."deleted_at" = 0
        LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
        LEFT JOIN intake_fwa_ids pf ON pf.mom_id = id.mom_id
        LEFT JOIN sixmo_fwa sw ON sw.mom_id = id.mom_id
        LEFT JOIN next_fwa nf ON nf.mom_id = id.mom_id
        GROUP BY aff."name"
        ORDER BY total_n DESC, aff."name"
      `),

      // ── Q4: Per-domain pre-score distributions (from ALL pre FWAs, broader pool) ──
      pool.query(`
        WITH
        ${PS_BATCH_CTE},
        ${INTAKE_CTES},
        pre_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
${PRE_COLS}
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
          ORDER BY w."mom_id", w."created_at" ASC
        ),
        unpivoted AS (
          ${DOMAINS.map(d => `SELECT '${d}' AS domain, ${d} AS val FROM pre_fwa`).join('\n          UNION ALL\n          ')}
        )
        SELECT
          domain,
          COUNT(*)::int                                              AS n,
          ROUND(AVG(val)::numeric, 2)                               AS mean,
          MIN(val)::numeric                                          AS mn,
          MAX(val)::numeric                                          AS mx,
          ROUND(STDDEV(val)::numeric, 2)                            AS stddev,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY val)::numeric, 2) AS median,
          COUNT(*) FILTER (WHERE val = (SELECT MAX(val) FROM unpivoted u2 WHERE u2.domain = unpivoted.domain))::int AS at_max_n
        FROM unpivoted
        GROUP BY domain
        ORDER BY domain
      `),

      // ── Q5: Main KPI method — pairing_start +30d pre / +60d post (matches report-data.js V6) ──
      // Returns one row per mom in active_pairings with their main-KPI pre/post FSS scores.
      pool.query(`
        WITH
        ${PS_BATCH_CTE},
        active_pairings AS (
          SELECT DISTINCT ON (p."momId")
            p."momId"::text AS mom_id,
            p."created_at"  AS pairing_start
          FROM "Pairing" p
          JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
          LEFT JOIN ps_batch pb ON pb.mom_id = m."id"::text
          WHERE p."deleted_at" = 0
            AND p."created_at" <= '${DATA_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" > '${DATA_START}')
            AND pb.mom_id IS NULL
          ORDER BY p."momId", p."created_at" DESC
        ),
        scored_was AS (
          SELECT wa."mom_id"::text AS mom_id, wa."created_at",
            (COALESCE(wa."ats_score",0) + COALESCE(wa."cc_score",0) + COALESCE(wa."edu_score",0)
             + COALESCE(wa."ei_score",0) + COALESCE(wa."fin_cpi_sum",0) + COALESCE(wa."home_score",0)
             + COALESCE(wa."naa_score",0) + COALESCE(wa."res_score",0) + COALESCE(wa."soc_score",0)
             + COALESCE(wa."trnprt_score",0) + COALESCE(wa."well_score",0)) AS fss_total
          FROM "WellnessAssessment" wa
          WHERE wa."deleted_at" = 0 AND wa."cpi_total" IS NOT NULL
            AND wa."created_at" <= '${DATA_END} 23:59:59'
        ),
        mom_fss AS (
          SELECT ap.mom_id,
            ap.pairing_start::date AS pairing_start_date,
            MAX(CASE WHEN sw."created_at" <= ap.pairing_start + INTERVAL '30 days'
                THEN sw.fss_total END) AS main_pre_fss,
            MAX(CASE WHEN sw."created_at" >= ap.pairing_start + INTERVAL '60 days'
                THEN sw.fss_total END) AS main_post_fss
          FROM active_pairings ap
          JOIN scored_was sw ON sw.mom_id = ap.mom_id
          GROUP BY ap.mom_id, ap.pairing_start
        )
        SELECT
          mf.mom_id,
          mf.pairing_start_date,
          mf.main_pre_fss,
          mf.main_post_fss,
          CASE WHEN mf.main_pre_fss IS NOT NULL AND mf.main_post_fss IS NOT NULL THEN 1 ELSE 0 END AS main_kpi_eligible,
          CASE WHEN mf.main_post_fss > mf.main_pre_fss THEN 1 ELSE 0 END AS main_kpi_improved
        FROM mom_fss mf
        ORDER BY main_kpi_eligible DESC, main_kpi_improved DESC
      `)
    ]);

    const rows           = pairedResult.rows;
    const gap            = gapResult.rows[0] || {};
    const affRows        = affResult.rows;
    const distRows       = distResult.rows;
    const mainKpiRows    = mainKpiResult.rows;

    // ── Q6: Question-level freeze analysis (sequential — depends on schema first) ──
    const qFreeze = await runQFreezeAnalysis(pool, PS_BATCH_CTE, INTAKE_CTES).catch(e => ({ error: e.message }));

    // ── Compute domain-level improvement rates from paired cohort ──
    const domainStats = {};
    for (const d of DOMAINS) {
      const paired = rows.filter(r => r[`pre_${d}`] != null && r[`post_${d}`] != null);
      const n      = paired.length;
      const up     = paired.filter(r => parseInt(r[`${d}_up`]) === 1).length;
      const same   = paired.filter(r => parseFloat(r[`post_${d}`]) === parseFloat(r[`pre_${d}`])).length;
      const down   = n - up - same;
      const preMean  = n ? paired.reduce((s,r) => s + parseFloat(r[`pre_${d}`]),  0) / n : null;
      const postMean = n ? paired.reduce((s,r) => s + parseFloat(r[`post_${d}`]), 0) / n : null;
      domainStats[d] = { n, up, same, down, preMean, postMean, label: DOMAIN_LABELS[d] };
    }

    // ── Top-level counts ──
    const paired_n       = rows.length;
    const fss_improved_n = rows.filter(r => parseInt(r.fss_improved) === 1).length;
    const any_domain_n   = rows.filter(r => parseInt(r.any_domain_improved) === 1).length;
    const flip_n         = rows.filter(r => parseInt(r.fss_vs_anydomain_flip) === 1).length;
    const inversion_n    = rows.filter(r => parseInt(r.temporal_inversion) === 1).length;

    // ── Ceiling flag: any domain where >40% of pre-pool at observed max ──
    const distByDomain = {};
    for (const dr of distRows) {
      distByDomain[dr.domain] = dr;
      dr.ceil_pct = dr.n > 0 ? Math.round(100 * dr.at_max_n / dr.n) : 0;
    }

    // ── Main KPI reconciliation (Q5) ──
    const mainKpiMap = {};
    for (const r of mainKpiRows) {
      mainKpiMap[r.mom_id] = {
        pairing_start_date: r.pairing_start_date,
        main_pre_fss:       r.main_pre_fss != null ? parseFloat(r.main_pre_fss) : null,
        main_post_fss:      r.main_post_fss != null ? parseFloat(r.main_post_fss) : null,
        main_kpi_eligible:  parseInt(r.main_kpi_eligible) === 1,
        main_kpi_improved:  parseInt(r.main_kpi_improved) === 1,
      };
    }
    const diagMomIds    = new Set(rows.map(r => r.mom_id));
    const main_eligible = mainKpiRows.filter(r => parseInt(r.main_kpi_eligible) === 1);
    const mainEligSet   = new Set(main_eligible.map(r => r.mom_id));
    const in_both       = main_eligible.filter(r => diagMomIds.has(r.mom_id));
    const main_only     = main_eligible.filter(r => !diagMomIds.has(r.mom_id));
    const diag_only     = rows.filter(r => !mainEligSet.has(r.mom_id));

    res.json({
      meta: {
        data_start: DATA_START, data_end: DATA_END,
        generated: new Date().toISOString(),
        domain_labels: DOMAIN_LABELS,
        kpi_note: 'Main KPI tile uses pairing_start +30d/+60d anchor. Diagnostic uses intake_date +91-180d anchor.',
      },
      counts: {
        total_organic:        parseInt(gap.total_organic) || 0,
        ps_migrated_n:        parseInt(gap.ps_migrated_n) || 0,
        has_intake_fwa_n:     parseInt(gap.has_pre_n) || 0,
        has_sixmo_fwa_n:      parseInt(gap.has_post_in_window_n) || 0,
        no_intake_fwa_n:      parseInt(gap.no_pre_n) || 0,
        no_followup_fwa_n:    parseInt(gap.no_second_fwa_n) || 0,
        has_3mo_only_n:       parseInt(gap.post_too_early_n) || 0,
        post_window_n:        parseInt(gap.post_too_late_n) || 0,
        paired_n,
        fss_improved_n,
        any_domain_n,
        flip_n,
        inversion_n,
        strict_n: rows.filter(r => parseInt(r.strict_kpi2) === 1).length,
      },
      kpiReconciliation: {
        main_active_pairings_n:  mainKpiRows.length,
        main_eligible_n:         main_eligible.length,
        main_improved_n:         main_eligible.filter(r => parseInt(r.main_kpi_improved) === 1).length,
        diagnostic_paired_n:     paired_n,
        diagnostic_improved_n:   fss_improved_n,
        in_both_n:               in_both.length,
        in_both_improved_n:      in_both.filter(r => parseInt(r.main_kpi_improved) === 1).length,
        main_only_n:             main_only.length,
        diag_only_n:             diag_only.length,
        mainOnlyRows: main_only.map(r => ({
          mom_id:           r.mom_id,
          pairing_start:    r.pairing_start_date,
          main_pre_fss:     r.main_pre_fss != null ? parseFloat(r.main_pre_fss) : null,
          main_post_fss:    r.main_post_fss != null ? parseFloat(r.main_post_fss) : null,
          main_kpi_improved: parseInt(r.main_kpi_improved) === 1,
        })),
        diagOnlyRows: diag_only.map(r => ({
          mom_id:        r.mom_id,
          first_name:    r.first_name,
          last_name:     r.last_name,
          affiliate:     r.affiliate_name,
          intake_date:   r.intake_date,
          intake_fss:    parseFloat(r.pre_fss),
          sixmo_fss:     parseFloat(r.post_fss),
          fss_improved:  parseInt(r.fss_improved) === 1,
        })),
      },
      affiliateFunnel: affRows,
      pairedRows: rows.map(r => ({
        mom_id:        r.mom_id,
        first_name:    r.first_name,
        last_name:     r.last_name,
        affiliate:     r.affiliate_name,
        strict_kpi2:   parseInt(r.strict_kpi2),
        intake_date:   r.intake_date,
        intake_fwa_date: r.pre_date,
        sixmo_fwa_date:  r.post_date,
        days_between:  parseInt(r.days_between),
        inversion:     parseInt(r.temporal_inversion) === 1,
        intake_link_sent: r.intake_link_sent === true || r.intake_link_sent === 't',
        sixmo_link_sent:  r.sixmo_link_sent === true || r.sixmo_link_sent === 't',
        intake_fss:    parseFloat(r.pre_fss),
        sixmo_fss:     parseFloat(r.post_fss),
        fss_delta:     parseFloat(r.fss_delta),
        fss_improved:  parseInt(r.fss_improved) === 1,
        any_domain_improved: parseInt(r.any_domain_improved) === 1,
        domains_improved_count: parseInt(r.domains_improved_count),
        flip:          parseInt(r.fss_vs_anydomain_flip) === 1,
        // Main KPI method scores for this mom (if she's in an active pairing)
        main_kpi_eligible: mainKpiMap[r.mom_id]?.main_kpi_eligible || false,
        main_kpi_improved: mainKpiMap[r.mom_id]?.main_kpi_improved || false,
        main_pre_fss:      mainKpiMap[r.mom_id]?.main_pre_fss ?? null,
        main_post_fss:     mainKpiMap[r.mom_id]?.main_post_fss ?? null,
        pairing_start:     mainKpiMap[r.mom_id]?.pairing_start_date ?? null,
        domains: DOMAINS.reduce((acc, d) => {
          acc[d] = {
            intake: parseFloat(r[`pre_${d}`]),
            sixmo:  parseFloat(r[`post_${d}`]),
            up:     parseInt(r[`${d}_up`]) === 1,
          };
          return acc;
        }, {}),
      })),
      domainStats,
      distByDomain,
      questionFreeze: qFreeze,
    });

  } catch (err) {
    console.error('[kpi2-diagnostic] error:', err);
    res.status(500).json({ error: err.message, detail: err.detail || null, hint: err.hint || null });
  }
});

module.exports = router;
