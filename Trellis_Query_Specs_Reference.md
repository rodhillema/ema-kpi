# Trellis Query Specs Reference

**Last updated:** 2026-05-15
**Branch locked to:** `main` (as of Fix 6 / PR #47)

This document captures the authoritative query methodology for each KPI and key metric
as it runs in production in `routes/report-data.js`. When a query changes, update this
doc in the same PR.

---

## Period Constants

```javascript
const PERIOD_START      = '2026-01-01';
const PERIOD_END        = '2026-03-31';
const PERIOD_GRACE_END  = '2026-04-30';   // 30-day grace for late entries
```

---

## KPI 2 — FSS Improvement Rate (target 70%)

### Locked spec (Cristina — April 24, 2026 / Fix 5b)

**Data source:** `WellnessAssessment` table — NOT `AssessmentResult` / `AssessmentResultQuestionResponse`.
The old `AssessmentResult`-based approach was superseded on April 24, 2026. Any reference to
`AssessmentResultQuestionResponse` for KPI 2 is stale and should be ignored.

**Cohort:** Period-active pairings (`PERIOD_PAIRING_FRAGMENT`) excluding moms whose
engagement record was bulk-imported on the Nov 30 / Dec 17 2025 PS-migration batch dates.

**Anchor:** `Pairing."created_at"` (pairing creation date).

**Pre FWA:** Highest scored WA within 30 days of pairing start (`<= pairing_start + 30 days`).

**Post FWA:** Highest scored WA at least 60 days after pairing start (`>= pairing_start + 60 days`).

**FSS formula (11 domains, direct sum):**
```
ats_score + cc_score + edu_score + ei_score + fin_cpi_sum
+ home_score + naa_score + res_score + soc_score + trnprt_score + well_score
```
`cw_score` is excluded — tracked separately for KPI 1 (Child Welfare / Family Preservation).

**"Scored" marker:** `cpi_total IS NOT NULL` on the `WellnessAssessment` row.
Drafts and incomplete submissions where `cpi_total` is null do not qualify.

**Minimum cohort threshold:** 10 eligible pairs. If `cohort_n < 10`, numerator and
denominator return `NULL` (frontend shows "Data Pending"). `cohort_n` always returns
the actual count so the frontend can explain why results are suppressed.

### Live SQL (as of Fix 5b / V6)

```sql
WITH
ps_batch AS (
  SELECT DISTINCT data->>'id' AS mom_id
  FROM "AuditLog"
  WHERE "table" = 'Mom' AND action = 'Update'
    AND data->>'prospect_status' = 'engaged_in_program'
    AND DATE_TRUNC('day', created_at) IN ('2025-11-30'::date, '2025-12-17'::date)
),
active_pairings AS (
  SELECT DISTINCT ON (p."momId")
    p."momId",
    p."created_at" AS pairing_start
  FROM "Pairing" p
  JOIN "Mom" m ON m."id" = p."momId" AND m."deleted_at" = 0
  LEFT JOIN ps_batch pb ON pb.mom_id = m."id"::text
  WHERE ${PERIOD_PAIRING_FRAGMENT}
    ${affWhere}
    AND pb.mom_id IS NULL
  ORDER BY p."momId", p."created_at" DESC
),
scored_was AS (
  SELECT
    wa."mom_id",
    wa."created_at",
    (COALESCE(wa."ats_score",0) + COALESCE(wa."cc_score",0) + COALESCE(wa."edu_score",0)
     + COALESCE(wa."ei_score",0) + COALESCE(wa."fin_cpi_sum",0) + COALESCE(wa."home_score",0)
     + COALESCE(wa."naa_score",0) + COALESCE(wa."res_score",0) + COALESCE(wa."soc_score",0)
     + COALESCE(wa."trnprt_score",0) + COALESCE(wa."well_score",0)) AS fss_total
  FROM "WellnessAssessment" wa
  WHERE wa."deleted_at" = 0 AND wa."cpi_total" IS NOT NULL
),
mom_fss AS (
  SELECT
    ap."momId",
    MAX(CASE WHEN sw."created_at" <= ap.pairing_start + INTERVAL '30 days'
        THEN sw.fss_total END) AS pre_fss,
    MAX(CASE WHEN sw."created_at" >= ap.pairing_start + INTERVAL '60 days'
        THEN sw.fss_total END) AS post_fss
  FROM active_pairings ap
  JOIN scored_was sw ON sw."mom_id" = ap."momId"
  GROUP BY ap."momId", ap.pairing_start
),
eligible AS (
  SELECT pre_fss, post_fss FROM mom_fss
  WHERE pre_fss IS NOT NULL AND post_fss IS NOT NULL
)
SELECT
  (SELECT COUNT(*)::int FROM active_pairings)                               AS base_cohort_n,
  COUNT(*)::int                                                              AS cohort_n,
  GREATEST((SELECT COUNT(*)::int FROM active_pairings) - COUNT(*)::int, 0) AS excluded_n,
  CASE WHEN COUNT(*) < 10 THEN NULL ELSE COUNT(*)::int END                 AS denominator,
  CASE WHEN COUNT(*) < 10 THEN NULL
       ELSE SUM(CASE WHEN post_fss > pre_fss THEN 1 ELSE 0 END)::int END  AS numerator
FROM eligible
```

### Response shape

```javascript
kpi2: {
  rate:        kpi2Rate,       // null if cohort_n < 10
  numerator:   kpi2Num,        // null if cohort_n < 10
  denominator: kpi2Den,        // null if cohort_n < 10
  cohort_n:    kpi2CohortN,    // always returned (used for pending-state message)
  excluded:    kpi2ExcludedN,  // base_cohort_n − cohort_n (PS-batch moms removed)
  status:      'ok' | 'pending',
  target:      70,
}
```

### Version history

| Version | Date | Change |
|---------|------|--------|
| V4 | pre-May 2026 | Pairing-start anchor, no PS-batch exclusion |
| V5 | May 2026 | Intake-anchored windows — reverted (showed data where prior version showed N/A) |
| V6 (Fix 5b) | 2026-05-15 | Restore V4 pairing-start anchor + add PS-batch exclusion; threshold raised to 10 |

---

## Advocate Q1 Activity

### Spec (Fix 6 — 2026-05-15)

**Applications / Trained / Approved:** User record `created_at` in Q1 — point-in-time
snapshot of where an advocate stands at creation. Not event-based.

**Became Active / Became Inactive:** Event-based, detected via `LAG()` window function
over consecutive `AuditLog` snapshots for each user. Counts DISTINCT `user_id`s who
transitioned INTO that status at any point during Q1. Period-locked — will not drift
if advocates change status after Q1 ends.

AuditLog rows contain full User snapshots (not diffs). To detect a transition, compare
each row's `data->>'advocate_status'` against the previous row for the same user.

**Affiliate scoping:** `affWhereAudit` → `data->>'affiliateId' = $1::text` (or `!=` or
empty for org-wide).

### Live SQL

```sql
WITH advocate_events AS (
  SELECT
    data->>'id'              AS user_id,
    data->>'advocate_status' AS status,
    created_at,
    LAG(data->>'advocate_status') OVER (
      PARTITION BY data->>'id' ORDER BY created_at
    ) AS prev_status
  FROM "AuditLog"
  WHERE "table" = 'User' AND action = 'Update'
    AND data->>'advocate_status' IS NOT NULL
    ${affWhereAudit}
)
SELECT
  (SELECT COUNT(*)::int FROM "User" u
    WHERE u."advocate_status" IS NOT NULL AND u."deleted_at" = 0
      AND u."created_at" >= '2026-01-01' AND u."created_at" <= '2026-03-31 23:59:59'
      ${affWhereUser}
  ) AS applications,
  (SELECT COUNT(*)::int FROM "User" u
    WHERE u."deleted_at" = 0
      AND u."advocate_sub_status"::text IN (
        'Training_Completed','Waiting_To_Be_Paired','Paired',
        'Pending_Final_Steps','Taking_A_Break'
      )
      AND u."created_at" >= '2026-01-01' AND u."created_at" <= '2026-03-31 23:59:59'
      ${affWhereUser}
  ) AS trained,
  (SELECT COUNT(*)::int FROM "User" u
    WHERE u."deleted_at" = 0
      AND u."advocate_sub_status"::text IN (
        'Training_Completed','Waiting_To_Be_Paired','Paired','Pending_Final_Steps'
      )
      AND u."created_at" >= '2026-01-01' AND u."created_at" <= '2026-03-31 23:59:59'
      ${affWhereUser}
  ) AS approved,
  COUNT(DISTINCT CASE
    WHEN status = 'Active'
     AND (prev_status IS NULL OR prev_status <> 'Active')
     AND created_at >= '2026-01-01' AND created_at <= '2026-03-31 23:59:59'
    THEN user_id END)::int AS became_active,
  COUNT(DISTINCT CASE
    WHEN status = 'Inactive'
     AND (prev_status IS NULL OR prev_status <> 'Inactive')
     AND created_at >= '2026-01-01' AND created_at <= '2026-03-31 23:59:59'
    THEN user_id END)::int AS became_inactive
FROM advocate_events
```

### Version history

| Version | Date | Change |
|---------|------|--------|
| V1 | pre-May 2026 | Current-state proxy: `advocate_status='Active'` + `updated_at` in Q1 |
| V2 (Fix 6) | 2026-05-15 | Event-based LAG() detection; DISTINCT user_id; period-locked |

---

## PS-Migration Exclusion Guard

The Nov 30 / Dec 17, 2025 AuditLog batch dates represent a bulk import of legacy
PromiseServes data into Trellis. Moms whose first `engaged_in_program` audit event
falls on those dates are excluded from KPI 2 cohorts to prevent pre-Trellis data
from contaminating Q1 2026 measurements.

```sql
ps_batch AS (
  SELECT DISTINCT data->>'id' AS mom_id
  FROM "AuditLog"
  WHERE "table" = 'Mom' AND action = 'Update'
    AND data->>'prospect_status' = 'engaged_in_program'
    AND DATE_TRUNC('day', created_at) IN ('2025-11-30'::date, '2025-12-17'::date)
)
-- Usage: LEFT JOIN ps_batch pb ON pb.mom_id = m."id"::text
--        WHERE ... AND pb.mom_id IS NULL
```

---

## Affiliate Scoping Patterns

Three filter fragments, all built from the same `affParams` array (`[$1]` = affiliate ID):

| Fragment | Table | Filter |
|----------|-------|--------|
| `affWhere` | `Mom` (aliased `m`) | `m."affiliate_id" = $1` |
| `affWhereUser` | `User` (aliased `u`) | `u."affiliateId" = $1` |
| `affWhereAudit` | `AuditLog` JSONB | `data->>'affiliateId' = $1::text` |

Org-wide users: all three fragments are empty string; `affParams = []`.
Exclude-one mode (`?exclude_affiliate_id=X`): fragments use `!=` instead of `=`.
