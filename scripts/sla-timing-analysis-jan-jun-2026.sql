-- ═══════════════════════════════════════════════════════════════════
-- SLA Timing Analysis: Impact Hub HQ — Jan–Jun 2026
--
-- Metrics:
--   1. Referral → First Contact, split by engaged vs did-not-engage
--      Day bands: ≤1, ≤2, ≤3, 4–7, 8–14, 14+, never contacted
--
--   2. Intake → First Pairing, split by track completed vs incomplete
--      Day bands: 0–7, 8–14, 15–21, 21+, never paired
--
-- Run each query block separately in Railway.
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
-- QUERY 1A: REFERRAL → FIRST CONTACT
--           by Affiliate × Month × Engagement Outcome
-- ───────────────────────────────────────────────────────────────────

WITH
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
  SELECT
    oo.mom_id,
    CASE
      WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
        THEN fs."completed_date"
      ELSE oo.coordinator_engaged_date
    END AS best_intake_date
  FROM organic_only oo
  LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
),
first_contact AS (
  SELECT mom_id, MIN(date_created_c) AS first_contact_date
  FROM "ConnectionLog"
  GROUP BY mom_id
),
base AS (
  SELECT
    a.name                                              AS affiliate,
    DATE_TRUNC('month', id.best_intake_date)            AS intake_month,
    CASE
      WHEN m.prospect_status::text = 'engaged_in_program'        THEN 'Engaged'
      WHEN m.prospect_status::text = 'did_not_engage_in_program' THEN 'Did Not Engage'
      ELSE 'Pending'
    END                                                 AS engagement_outcome,
    CASE
      WHEN fc.first_contact_date IS NOT NULL
        THEN EXTRACT(DAY FROM fc.first_contact_date - m.created_at)
    END                                                 AS days_to_contact
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
  TO_CHAR(intake_month, 'Mon YYYY')                                      AS month,
  engagement_outcome,
  COUNT(*)                                                                AS families,
  COUNT(*) FILTER (WHERE days_to_contact <= 1)                           AS within_1d,
  COUNT(*) FILTER (WHERE days_to_contact = 2)                            AS within_2d,
  COUNT(*) FILTER (WHERE days_to_contact = 3)                            AS within_3d,
  COUNT(*) FILTER (WHERE days_to_contact BETWEEN 4 AND 7)               AS d_4_to_7,
  COUNT(*) FILTER (WHERE days_to_contact BETWEEN 8 AND 14)              AS d_8_to_14,
  COUNT(*) FILTER (WHERE days_to_contact > 14)                          AS over_14d,
  COUNT(*) FILTER (WHERE days_to_contact IS NULL)                        AS never_contacted
FROM base
GROUP BY affiliate, intake_month, engagement_outcome
ORDER BY affiliate, intake_month, engagement_outcome;


-- ───────────────────────────────────────────────────────────────────
-- QUERY 1B: REFERRAL → FIRST CONTACT — OVERALL × MONTH × OUTCOME
-- ───────────────────────────────────────────────────────────────────

WITH
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
  SELECT
    oo.mom_id,
    CASE
      WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
        THEN fs."completed_date"
      ELSE oo.coordinator_engaged_date
    END AS best_intake_date
  FROM organic_only oo
  LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
),
first_contact AS (
  SELECT mom_id, MIN(date_created_c) AS first_contact_date
  FROM "ConnectionLog"
  GROUP BY mom_id
),
base AS (
  SELECT
    DATE_TRUNC('month', id.best_intake_date)            AS intake_month,
    CASE
      WHEN m.prospect_status::text = 'engaged_in_program'        THEN 'Engaged'
      WHEN m.prospect_status::text = 'did_not_engage_in_program' THEN 'Did Not Engage'
      ELSE 'Pending'
    END                                                 AS engagement_outcome,
    CASE
      WHEN fc.first_contact_date IS NOT NULL
        THEN EXTRACT(DAY FROM fc.first_contact_date - m.created_at)
    END                                                 AS days_to_contact
  FROM "Mom" m
  JOIN "Affiliate" a ON a.id = m.affiliate_id
  JOIN intake_dates id ON id.mom_id = m.id::text
  LEFT JOIN first_contact fc ON fc.mom_id = m.id
  WHERE m.deleted_at = 0
    AND id.best_intake_date >= '2026-01-01'
    AND id.best_intake_date <  '2026-07-01'
)
SELECT
  TO_CHAR(intake_month, 'Mon YYYY')                                      AS month,
  engagement_outcome,
  COUNT(*)                                                                AS families,
  COUNT(*) FILTER (WHERE days_to_contact <= 1)                           AS within_1d,
  COUNT(*) FILTER (WHERE days_to_contact = 2)                            AS within_2d,
  COUNT(*) FILTER (WHERE days_to_contact = 3)                            AS within_3d,
  COUNT(*) FILTER (WHERE days_to_contact BETWEEN 4 AND 7)               AS d_4_to_7,
  COUNT(*) FILTER (WHERE days_to_contact BETWEEN 8 AND 14)              AS d_8_to_14,
  COUNT(*) FILTER (WHERE days_to_contact > 14)                          AS over_14d,
  COUNT(*) FILTER (WHERE days_to_contact IS NULL)                        AS never_contacted
FROM base
GROUP BY intake_month, engagement_outcome
ORDER BY intake_month, engagement_outcome;


-- ───────────────────────────────────────────────────────────────────
-- QUERY 2A: INTAKE → FIRST PAIRING
--           by Affiliate × Month × Track Outcome
--
-- track_outcome:
--   'Completed Track'     = at least one Pairing with status = 'pairing_complete'
--   'Incomplete / Active' = paired but no completed pairing yet
--   'Never Paired'        = no Pairing record at all
-- ───────────────────────────────────────────────────────────────────

WITH
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
  SELECT
    oo.mom_id,
    CASE
      WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
        THEN fs."completed_date"
      ELSE oo.coordinator_engaged_date
    END AS best_intake_date
  FROM organic_only oo
  LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
),
first_pairing AS (
  SELECT "momId" AS mom_id, MIN(created_at) AS first_pairing_date
  FROM "Pairing"
  WHERE deleted_at = 0
  GROUP BY "momId"
),
track_completion AS (
  SELECT "momId" AS mom_id,
    BOOL_OR(status::text = 'pairing_complete') AS completed_any_track
  FROM "Pairing"
  WHERE deleted_at = 0
  GROUP BY "momId"
),
base AS (
  SELECT
    a.name                                              AS affiliate,
    DATE_TRUNC('month', id.best_intake_date)            AS intake_month,
    CASE
      WHEN fp.first_pairing_date IS NULL  THEN 'Never Paired'
      WHEN tc.completed_any_track = true  THEN 'Completed Track'
      ELSE 'Incomplete / Active'
    END                                                 AS track_outcome,
    CASE
      WHEN fp.first_pairing_date IS NOT NULL
        THEN EXTRACT(DAY FROM fp.first_pairing_date - id.best_intake_date)
    END                                                 AS days_to_pairing
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
  TO_CHAR(intake_month, 'Mon YYYY')                                      AS month,
  track_outcome,
  COUNT(*)                                                                AS families,
  COUNT(*) FILTER (WHERE days_to_pairing IS NOT NULL AND days_to_pairing <= 7)              AS d_0_to_7,
  COUNT(*) FILTER (WHERE days_to_pairing BETWEEN 8 AND 14)              AS d_8_to_14,
  COUNT(*) FILTER (WHERE days_to_pairing BETWEEN 15 AND 21)             AS d_15_to_21,
  COUNT(*) FILTER (WHERE days_to_pairing > 21)                          AS over_21d
FROM base
GROUP BY affiliate, intake_month, track_outcome
ORDER BY affiliate, intake_month, track_outcome;


-- ───────────────────────────────────────────────────────────────────
-- QUERY 2B: INTAKE → FIRST PAIRING — OVERALL × MONTH × TRACK OUTCOME
-- ───────────────────────────────────────────────────────────────────

WITH
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
  SELECT
    oo.mom_id,
    CASE
      WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
        THEN fs."completed_date"
      ELSE oo.coordinator_engaged_date
    END AS best_intake_date
  FROM organic_only oo
  LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id
),
first_pairing AS (
  SELECT "momId" AS mom_id, MIN(created_at) AS first_pairing_date
  FROM "Pairing"
  WHERE deleted_at = 0
  GROUP BY "momId"
),
track_completion AS (
  SELECT "momId" AS mom_id,
    BOOL_OR(status::text = 'pairing_complete') AS completed_any_track
  FROM "Pairing"
  WHERE deleted_at = 0
  GROUP BY "momId"
),
base AS (
  SELECT
    DATE_TRUNC('month', id.best_intake_date)            AS intake_month,
    CASE
      WHEN fp.first_pairing_date IS NULL  THEN 'Never Paired'
      WHEN tc.completed_any_track = true  THEN 'Completed Track'
      ELSE 'Incomplete / Active'
    END                                                 AS track_outcome,
    CASE
      WHEN fp.first_pairing_date IS NOT NULL
        THEN EXTRACT(DAY FROM fp.first_pairing_date - id.best_intake_date)
    END                                                 AS days_to_pairing
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
  TO_CHAR(intake_month, 'Mon YYYY')                                      AS month,
  track_outcome,
  COUNT(*)                                                                AS families,
  COUNT(*) FILTER (WHERE days_to_pairing IS NOT NULL AND days_to_pairing <= 7)              AS d_0_to_7,
  COUNT(*) FILTER (WHERE days_to_pairing BETWEEN 8 AND 14)              AS d_8_to_14,
  COUNT(*) FILTER (WHERE days_to_pairing BETWEEN 15 AND 21)             AS d_15_to_21,
  COUNT(*) FILTER (WHERE days_to_pairing > 21)                          AS over_21d
FROM base
GROUP BY intake_month, track_outcome
ORDER BY intake_month, track_outcome;
