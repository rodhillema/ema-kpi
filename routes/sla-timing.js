const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth } = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'administrator') return next();
  res.status(403).json({ error: 'Access denied' });
}

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
    WHERE DATE_TRUNC('day', coordinator_engaged_date) NOT IN (
      '2025-11-30'::date, '2025-12-17'::date
    )
  ),
  fwa_status AS (
    SELECT DISTINCT ON ("mom_id") "mom_id", "completed_ahead", "completed_date"
    FROM "WellnessAssessment"
    WHERE "deleted_at" = 0
    ORDER BY "mom_id", "created_at" ASC
  ),
  intake_dates AS (
    SELECT oo.mom_id,
      CASE
        WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
          THEN fs."completed_date"
        ELSE oo.coordinator_engaged_date
      END AS best_intake_date
    FROM organic_only oo
    LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
  )`;

// GET /api/sla-timing
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [contactOverall, contactByAffiliate, pairingOverall, pairingByAffiliate, affiliates] =
      await Promise.all([

        // ── Contact: overall × month × engagement outcome ──────────────
        pool.query(`WITH ${INTAKE_CTE},
          first_contact AS (
            SELECT mom_id, MIN(date_created_c) AS first_contact_date
            FROM "ConnectionLog" GROUP BY mom_id
          ),
          base AS (
            SELECT
              DATE_TRUNC('month', id.best_intake_date) AS intake_month,
              CASE
                WHEN m.prospect_status::text = 'engaged_in_program'        THEN 'Engaged'
                WHEN m.prospect_status::text = 'did_not_engage_in_program' THEN 'Did Not Engage'
                ELSE 'Pending'
              END AS outcome,
              CASE WHEN fc.first_contact_date IS NOT NULL
                THEN (SELECT COUNT(*)::int FROM generate_series(m.created_at::date + 1, fc.first_contact_date::date, '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 5)
              END AS days
            FROM "Mom" m
            JOIN "Affiliate" a ON a.id = m.affiliate_id
            JOIN intake_dates id ON id.mom_id = m.id::text
            LEFT JOIN first_contact fc ON fc.mom_id = m.id
            WHERE m.deleted_at = 0
              AND id.best_intake_date >= '2026-01-01'
              AND id.best_intake_date <  '2026-07-01'
          )
          SELECT
            TO_CHAR(intake_month, 'YYYY-MM') AS month_key,
            TO_CHAR(intake_month, 'Mon YYYY') AS month,
            outcome,
            COUNT(*)::int                                                     AS families,
            COUNT(*) FILTER (WHERE days <= 1)::int                           AS d1,
            COUNT(*) FILTER (WHERE days = 2)::int                            AS d2,
            COUNT(*) FILTER (WHERE days = 3)::int                            AS d3,
            COUNT(*) FILTER (WHERE days BETWEEN 4 AND 7)::int               AS d4_7,
            COUNT(*) FILTER (WHERE days BETWEEN 8 AND 14)::int              AS d8_14,
            COUNT(*) FILTER (WHERE days > 14)::int                          AS over14,
            COUNT(*) FILTER (WHERE days IS NULL)::int                        AS never
          FROM base
          GROUP BY intake_month, outcome
          ORDER BY intake_month, outcome`),

        // ── Contact: by affiliate × month × outcome ────────────────────
        pool.query(`WITH ${INTAKE_CTE},
          first_contact AS (
            SELECT mom_id, MIN(date_created_c) AS first_contact_date
            FROM "ConnectionLog" GROUP BY mom_id
          ),
          base AS (
            SELECT
              a.name AS affiliate,
              DATE_TRUNC('month', id.best_intake_date) AS intake_month,
              CASE
                WHEN m.prospect_status::text = 'engaged_in_program'        THEN 'Engaged'
                WHEN m.prospect_status::text = 'did_not_engage_in_program' THEN 'Did Not Engage'
                ELSE 'Pending'
              END AS outcome,
              CASE WHEN fc.first_contact_date IS NOT NULL
                THEN (SELECT COUNT(*)::int FROM generate_series(m.created_at::date + 1, fc.first_contact_date::date, '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 5)
              END AS days
            FROM "Mom" m
            JOIN "Affiliate" a ON a.id = m.affiliate_id
            JOIN intake_dates id ON id.mom_id = m.id::text
            LEFT JOIN first_contact fc ON fc.mom_id = m.id
            WHERE m.deleted_at = 0
              AND id.best_intake_date >= '2026-01-01'
              AND id.best_intake_date <  '2026-07-01'
          )
          SELECT
            affiliate,
            TO_CHAR(intake_month, 'YYYY-MM') AS month_key,
            TO_CHAR(intake_month, 'Mon YYYY') AS month,
            outcome,
            COUNT(*)::int                                                     AS families,
            COUNT(*) FILTER (WHERE days <= 1)::int                           AS d1,
            COUNT(*) FILTER (WHERE days = 2)::int                            AS d2,
            COUNT(*) FILTER (WHERE days = 3)::int                            AS d3,
            COUNT(*) FILTER (WHERE days BETWEEN 4 AND 7)::int               AS d4_7,
            COUNT(*) FILTER (WHERE days BETWEEN 8 AND 14)::int              AS d8_14,
            COUNT(*) FILTER (WHERE days > 14)::int                          AS over14,
            COUNT(*) FILTER (WHERE days IS NULL)::int                        AS never
          FROM base
          GROUP BY affiliate, intake_month, outcome
          ORDER BY affiliate, intake_month, outcome`),

        // ── Pairing: overall × month × track outcome ───────────────────
        pool.query(`WITH ${INTAKE_CTE},
          first_pairing AS (
            SELECT "momId" AS mom_id, MIN(created_at) AS first_pairing_date
            FROM "Pairing" WHERE deleted_at = 0 GROUP BY "momId"
          ),
          track_completion AS (
            SELECT "momId" AS mom_id,
              BOOL_OR(status::text = 'pairing_complete') AS completed_any_track
            FROM "Pairing" WHERE deleted_at = 0 GROUP BY "momId"
          ),
          base AS (
            SELECT
              DATE_TRUNC('month', id.best_intake_date) AS intake_month,
              CASE
                WHEN fp.first_pairing_date IS NULL  THEN 'Never Paired'
                WHEN tc.completed_any_track = true  THEN 'Completed Track'
                ELSE 'Incomplete / Active'
              END AS outcome,
              CASE WHEN fp.first_pairing_date IS NOT NULL
                THEN (SELECT COUNT(*)::int FROM generate_series(id.best_intake_date::date + 1, fp.first_pairing_date::date, '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 5)
              END AS days
            FROM "Mom" m
            JOIN "Affiliate" a ON a.id = m.affiliate_id
            JOIN intake_dates id ON id.mom_id = m.id::text
            LEFT JOIN first_pairing fp ON fp.mom_id = m.id
            LEFT JOIN track_completion tc ON tc.mom_id = m.id
            WHERE m.deleted_at = 0
              AND id.best_intake_date >= '2026-01-01'
              AND id.best_intake_date <  '2026-07-01'
          )
          SELECT
            TO_CHAR(intake_month, 'YYYY-MM') AS month_key,
            TO_CHAR(intake_month, 'Mon YYYY') AS month,
            outcome,
            COUNT(*)::int                                                     AS families,
            COUNT(*) FILTER (WHERE days IS NOT NULL AND days <= 7)::int      AS d0_7,
            COUNT(*) FILTER (WHERE days BETWEEN 8 AND 14)::int              AS d8_14,
            COUNT(*) FILTER (WHERE days BETWEEN 15 AND 21)::int             AS d15_21,
            COUNT(*) FILTER (WHERE days > 21)::int                          AS over21,
            COUNT(*) FILTER (WHERE days IS NULL AND outcome != 'Never Paired')::int AS never
          FROM base
          GROUP BY intake_month, outcome
          ORDER BY intake_month, outcome`),

        // ── Pairing: by affiliate × month × track outcome ─────────────
        pool.query(`WITH ${INTAKE_CTE},
          first_pairing AS (
            SELECT "momId" AS mom_id, MIN(created_at) AS first_pairing_date
            FROM "Pairing" WHERE deleted_at = 0 GROUP BY "momId"
          ),
          track_completion AS (
            SELECT "momId" AS mom_id,
              BOOL_OR(status::text = 'pairing_complete') AS completed_any_track
            FROM "Pairing" WHERE deleted_at = 0 GROUP BY "momId"
          ),
          base AS (
            SELECT
              a.name AS affiliate,
              DATE_TRUNC('month', id.best_intake_date) AS intake_month,
              CASE
                WHEN fp.first_pairing_date IS NULL  THEN 'Never Paired'
                WHEN tc.completed_any_track = true  THEN 'Completed Track'
                ELSE 'Incomplete / Active'
              END AS outcome,
              CASE WHEN fp.first_pairing_date IS NOT NULL
                THEN (SELECT COUNT(*)::int FROM generate_series(id.best_intake_date::date + 1, fp.first_pairing_date::date, '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 5)
              END AS days
            FROM "Mom" m
            JOIN "Affiliate" a ON a.id = m.affiliate_id
            JOIN intake_dates id ON id.mom_id = m.id::text
            LEFT JOIN first_pairing fp ON fp.mom_id = m.id
            LEFT JOIN track_completion tc ON tc.mom_id = m.id
            WHERE m.deleted_at = 0
              AND id.best_intake_date >= '2026-01-01'
              AND id.best_intake_date <  '2026-07-01'
          )
          SELECT
            affiliate,
            TO_CHAR(intake_month, 'YYYY-MM') AS month_key,
            TO_CHAR(intake_month, 'Mon YYYY') AS month,
            outcome,
            COUNT(*)::int                                                     AS families,
            COUNT(*) FILTER (WHERE days IS NOT NULL AND days <= 7)::int      AS d0_7,
            COUNT(*) FILTER (WHERE days BETWEEN 8 AND 14)::int              AS d8_14,
            COUNT(*) FILTER (WHERE days BETWEEN 15 AND 21)::int             AS d15_21,
            COUNT(*) FILTER (WHERE days > 21)::int                          AS over21,
            COUNT(*) FILTER (WHERE days IS NULL AND outcome != 'Never Paired')::int AS never
          FROM base
          GROUP BY affiliate, intake_month, outcome
          ORDER BY affiliate, intake_month, outcome`),

        // ── Affiliate list ─────────────────────────────────────────────
        pool.query(`
          SELECT DISTINCT a.name AS affiliate
          FROM "Mom" m
          JOIN "Affiliate" a ON a.id = m.affiliate_id
          JOIN (
            SELECT data->>'id' AS mom_id, MIN(created_at) AS dt
            FROM "AuditLog"
            WHERE "table" = 'Mom' AND action = 'Update'
              AND data->>'prospect_status' = 'engaged_in_program'
            GROUP BY data->>'id'
          ) al ON al.mom_id = m.id::text
          WHERE m.deleted_at = 0
            AND al.dt >= '2026-01-01' AND al.dt < '2026-07-01'
          ORDER BY a.name`),
      ]);

    res.json({
      contact: {
        overall:     contactOverall.rows,
        byAffiliate: contactByAffiliate.rows,
      },
      pairing: {
        overall:     pairingOverall.rows,
        byAffiliate: pairingByAffiliate.rows,
      },
      affiliates: affiliates.rows.map(r => r.affiliate),
    });
  } catch (err) {
    console.error('[sla-timing]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
