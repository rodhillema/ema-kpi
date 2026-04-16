# ĒMA Trellis — Intake Date Methodology
**Confirmed April 2026 | v2 — Updated after validation with engineering and live data**

---

## There is no dedicated intake date field

There is no single field anywhere in the Trellis database that directly stores intake date. It is always a derived value.

| Field | Why it does not work as intake date |
|---|---|
| `Mom.created_at` | Records when the Mom record was created — could be at referral, before any intake happened |
| `Mom.date_entered` | Same problem — populated at record creation, not intake |
| `WellnessAssessment.completed_date` alone | Correct for link-based intakes only — see population breakdown below |
| `WellnessAssessment.updated_at` | Resets on any field-level edit — not a reliable event timestamp |
| `Pairing.created_at` | Records when an advocate was paired — happens after intake, not at intake |

---

## Three populations — handle separately, never conflate

| Population | Size (April 2026) | How to identify | Intake date source |
|---|---|---|---|
| **PS-migrated moms** | 115 moms | First `engaged_in_program` AuditLog event falls on Nov 30 or Dec 17, 2025 | No reliable intake date — exclude, surface count |
| **Coordinator-led intakes** | 307 moms (83.4%) | `WellnessAssessment.completed_ahead = false` | First `engaged_in_program` timestamp from AuditLog |
| **Link-based intakes** | 97 moms (16.6%) | `WellnessAssessment.completed_ahead = true` | `WellnessAssessment.completed_date` — coordinator finalization date |

---

## V2 change from V1

**V1** used AuditLog blank `updated_by_name` rows to detect link-based intakes.
**V2** uses `WellnessAssessment.completed_ahead = true` — a proper boolean field, validated with engineering. More reliable, simpler query.

---

## The refined intake date logic

### Step 1 — Exclude PS-migrated moms
```sql
WHERE DATE_TRUNC('day', first_engaged_date) NOT IN ('2025-11-30', '2025-12-17')
```

### Step 2 — Split remaining moms by intake method
```sql
CASE
  WHEN wa.completed_ahead = true
    THEN wa.completed_date  -- link-based: coordinator finalization date
  ELSE
    MIN(al.created_at)      -- coordinator-led: first engaged_in_program timestamp
END AS best_intake_date
```

### Step 3 — Output three columns
| Column | Description |
|---|---|
| `mom_id` | FK to Mom table |
| `best_intake_date` | Corrected intake date |
| `intake_method` | `ps_migrated` / `coordinator_led` / `link_based` |

---

## Production SQL (PostgreSQL)

```sql
WITH first_engaged AS (
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
)
SELECT
  oo.mom_id,
  CASE
    WHEN fs."completed_ahead" = true AND fs."completed_date" IS NOT NULL
      THEN fs."completed_date"
    ELSE oo.coordinator_engaged_date
  END AS best_intake_date,
  CASE
    WHEN fs."completed_ahead" = true THEN 'link_based'
    ELSE 'coordinator_led'
  END AS intake_method
FROM organic_only oo
LEFT JOIN fwa_status fs ON fs."mom_id" = oo.mom_id;
```

---

## Key confirmed values (April 2026)

| Item | Confirmed value |
|---|---|
| Trellis go-live | December 2025 |
| PS migration batch 1 | 2025-11-30 (42 moms) |
| PS migration batch 2 | 2025-12-17 (73 moms) |
| Total PS-migrated | 115 moms |
| `prospect_status` intake value | `engaged_in_program` |
| `completed_ahead = true` | Link-based intake — use `completed_date` |
| `completed_ahead = false` | Coordinator-led intake — use AuditLog timestamp |
| Engineering contact | Jon Chen |
