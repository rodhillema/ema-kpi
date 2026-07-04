/* ============================================================
   /api/kpi2-trial - KPI 2 Domain-Improvement Trial
   Widened cohort: any mom with intake date + pre FWA + post FWA
   in 91-180 day window. Each row tagged strict_kpi2 = 1 if she
   also passes the official KPI 2 eligibility criteria.
   Visible to cristina.galloway only.
   ============================================================ */

const express = require('express');
const router = express.Router();
const pool = require('../db');

const PERIOD_END = '2026-06-30';
const PERIOD_START = '2026-01-01';

function requireCristina(req, res, next) {
  const username = ((req.session && req.session.user && req.session.user.username) || '').toLowerCase();
  if (username !== 'cristina.galloway') {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

// Mirrors production INTAKE_CTE from report-data.js lines 273-300
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
  )
`;

router.get('/', requireCristina, async (req, res) => {
  try {
    const [rowsResult, excResult] = await Promise.all([
      pool.query(`
        WITH
        ps_batch AS (
          SELECT DISTINCT data->>'id' AS mom_id
          FROM "AuditLog"
          WHERE "table" = 'Mom' AND action = 'Update'
            AND data->>'prospect_status' = 'engaged_in_program'
            AND DATE_TRUNC('day', created_at)
              IN ('2025-11-30'::date, '2025-12-17'::date)
        ),
        ${INTAKE_CTES},
        strict_kpi2_cohort AS (
          SELECT DISTINCT p."momId"::text AS mom_id
          FROM "Pairing" p
          JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
          LEFT JOIN ps_batch pb ON pb.mom_id = m."id"::text
          WHERE p."deleted_at" = 0
            AND p."created_at" <= '${PERIOD_END} 23:59:59'
            AND (p."completed_on" IS NULL OR p."completed_on" > '${PERIOD_START}')
            AND pb.mom_id IS NULL
        ),
        pre_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text                AS mom_id,
            w."created_at"                  AS pre_created_at,
            COALESCE(w."ats_score",0)       AS ats,
            COALESCE(w."cc_score",0)        AS cc,
            COALESCE(w."edu_score",0)       AS edu,
            COALESCE(w."ei_score",0)        AS ei,
            COALESCE(w."fin_cpi_sum",0)     AS fin,
            COALESCE(w."home_score",0)      AS home,
            COALESCE(w."naa_score",0)       AS naa,
            COALESCE(w."res_score",0)       AS res,
            COALESCE(w."soc_score",0)       AS soc,
            COALESCE(w."trnprt_score",0)    AS trnprt,
            COALESCE(w."well_score",0)      AS well
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
          ORDER BY w."mom_id", w."created_at" ASC
        ),
        post_fwa AS (
          SELECT DISTINCT ON (w."mom_id")
            w."mom_id"::text                AS mom_id,
            w."updated_at"                  AS post_updated_at,
            COALESCE(w."ats_score",0)       AS ats,
            COALESCE(w."cc_score",0)        AS cc,
            COALESCE(w."edu_score",0)       AS edu,
            COALESCE(w."ei_score",0)        AS ei,
            COALESCE(w."fin_cpi_sum",0)     AS fin,
            COALESCE(w."home_score",0)      AS home,
            COALESCE(w."naa_score",0)       AS naa,
            COALESCE(w."res_score",0)       AS res,
            COALESCE(w."soc_score",0)       AS soc,
            COALESCE(w."trnprt_score",0)    AS trnprt,
            COALESCE(w."well_score",0)      AS well
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
            AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
          ORDER BY w."mom_id", w."updated_at" DESC
        )
        SELECT
          p.mom_id,
          CASE WHEN s.mom_id IS NOT NULL THEN 1 ELSE 0 END AS strict_kpi2,
          (p.ats+p.cc+p.edu+p.ei+p.fin+p.home+p.naa+p.res+p.soc+p.trnprt+p.well) AS pre_fss,
          (q.ats+q.cc+q.edu+q.ei+q.fin+q.home+q.naa+q.res+q.soc+q.trnprt+q.well) AS post_fss,
          (q.ats+q.cc+q.edu+q.ei+q.fin+q.home+q.naa+q.res+q.soc+q.trnprt+q.well)
            - (p.ats+p.cc+p.edu+p.ei+p.fin+p.home+p.naa+p.res+p.soc+p.trnprt+p.well) AS fss_delta,
          ( (q.ats>p.ats)::int + (q.cc>p.cc)::int + (q.edu>p.edu)::int + (q.ei>p.ei)::int
          + (q.fin>p.fin)::int + (q.home>p.home)::int + (q.naa>p.naa)::int + (q.res>p.res)::int
          + (q.soc>p.soc)::int + (q.trnprt>p.trnprt)::int + (q.well>p.well)::int ) AS domains_increased,
          ( (q.ats<p.ats)::int + (q.cc<p.cc)::int + (q.edu<p.edu)::int + (q.ei<p.ei)::int
          + (q.fin<p.fin)::int + (q.home<p.home)::int + (q.naa<p.naa)::int + (q.res<p.res)::int
          + (q.soc<p.soc)::int + (q.trnprt<p.trnprt)::int + (q.well<p.well)::int ) AS domains_decreased,
          ( (q.ats=p.ats)::int + (q.cc=p.cc)::int + (q.edu=p.edu)::int + (q.ei=p.ei)::int
          + (q.fin=p.fin)::int + (q.home=p.home)::int + (q.naa=p.naa)::int + (q.res=p.res)::int
          + (q.soc=p.soc)::int + (q.trnprt=p.trnprt)::int + (q.well=p.well)::int ) AS domains_unchanged,
          CASE WHEN
            ( (q.ats>p.ats)::int + (q.cc>p.cc)::int + (q.edu>p.edu)::int + (q.ei>p.ei)::int
            + (q.fin>p.fin)::int + (q.home>p.home)::int + (q.naa>p.naa)::int + (q.res>p.res)::int
            + (q.soc>p.soc)::int + (q.trnprt>p.trnprt)::int + (q.well>p.well)::int ) >= 1
            THEN 1 ELSE 0 END AS any_domain_improved,
          CASE WHEN
            (q.ats+q.cc+q.edu+q.ei+q.fin+q.home+q.naa+q.res+q.soc+q.trnprt+q.well)
            > (p.ats+p.cc+p.edu+p.ei+p.fin+p.home+p.naa+p.res+p.soc+p.trnprt+p.well)
            THEN 1 ELSE 0 END AS fss_improved,
          p.pre_created_at::date  AS pre_created_at,
          q.post_updated_at::date AS post_updated_at,
          (q.post_updated_at::date - p.pre_created_at::date) AS days_between
        FROM pre_fwa p
        JOIN post_fwa q ON q.mom_id = p.mom_id
        LEFT JOIN strict_kpi2_cohort s ON s.mom_id = p.mom_id
        ORDER BY strict_kpi2 DESC, fss_delta DESC
      `),

      pool.query(`
        WITH
        ps_batch AS (
          SELECT DISTINCT data->>'id' AS mom_id
          FROM "AuditLog"
          WHERE "table" = 'Mom' AND action = 'Update'
            AND data->>'prospect_status' = 'engaged_in_program'
            AND DATE_TRUNC('day', created_at)
              IN ('2025-11-30'::date, '2025-12-17'::date)
        ),
        ${INTAKE_CTES},
        pre_ids AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
        ),
        post_ids AS (
          SELECT DISTINCT w."mom_id"::text AS mom_id
          FROM "WellnessAssessment" w
          JOIN intake_dates id ON id.mom_id = w."mom_id"::text
          WHERE w."cpi_total" IS NOT NULL AND w."deleted_at" = 0
            AND w."updated_at" >= id.intake_date + INTERVAL '91 days'
            AND w."updated_at" <= id.intake_date + INTERVAL '180 days'
        )
        SELECT
          (SELECT COUNT(*)::int FROM ps_batch)       AS ps_migrated_n,
          (SELECT COUNT(*)::int FROM intake_dates)   AS total_with_intake,
          (SELECT COUNT(*)::int FROM intake_dates id
             WHERE NOT EXISTS (
               SELECT 1 FROM pre_ids p WHERE p.mom_id = id.mom_id
             ))                                      AS missing_pre_n,
          (SELECT COUNT(*)::int FROM pre_ids p
             WHERE NOT EXISTS (
               SELECT 1 FROM post_ids q WHERE q.mom_id = p.mom_id
             ))                                      AS missing_post_n
      `)
    ]);

    res.json({
      rows: rowsResult.rows,
      exclusions: excResult.rows[0],
      period_end: PERIOD_END,
    });
  } catch (err) {
    console.error('[kpi2-trial] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
