# ĒMA Trellis — Intake Date Methodology
**Confirmed April 2026 | For use in dashboard pipeline and Power BI development**

---

## There is no dedicated intake date field

There is no single field anywhere in the Trellis database that directly stores intake date. It is always a derived value. The closest existing fields and why they do not work:

| Field | Why it does not work as intake date |
|---|---|
| `Mom.created_at` | Records when the Mom record was created — could be at referral, before any intake happened |
| `Mom.date_entered` | Same problem — populated at record creation, not intake |
| `WellnessAssessment.completed_date` | Assessment completion date, not program entry — missing for 46% of active moms, and reflects latest re-assessment for moms assessed multiple times |
| `Pairing.created_at` | Records when an advocate was paired — happens after intake, not at intake |

---

## Three populations — handle separately, never conflate

| Population | How to identify | Intake date available? |
|---|---|---|
| **PS-migrated moms** | First `engaged_in_program` AuditLog event falls on Nov 30 or Dec 17, 2025 | ❌ No — timestamp is migration artifact, not real intake |
| **Coordinator-led Trellis intakes** | First `engaged_in_program` event has a coordinator name in `updated_by_name` — no blank rows follow | ✅ Yes — use first `engaged_in_program` timestamp |
| **Link-based Trellis intakes** | First `engaged_in_program` event set by coordinator, followed by blank `updated_by_name` rows as mom completes the form herself | ✅ Yes — but use first blank `updated_by_name` timestamp after engaged, not the coordinator's timestamp |

**As of April 2026:**
- 115 PS-migrated moms (excluded from intake-dependent calculations)
- 307 coordinator-led (83.4% of Trellis-era moms)
- 61 link-based (16.6% of Trellis-era moms)

---

## Why link-based intakes need a different timestamp

When coordinators send a self-service intake link, they often set `prospect_status = engaged_in_program` in Trellis **before** the mom has actually completed the form — sometimes hours or days before. The mom then completes the form herself, which writes a series of AuditLog updates with a **blank `updated_by_name` field**. The coordinator's timestamp is premature. The first blank `updated_by_name` row after the coordinator's engaged event is the true intake completion timestamp.

---

## The refined intake date logic

### Step 1 — Exclude PS-migrated moms
```sql
WHERE DATE_TRUNC('day', first_engaged_date)
  NOT IN ('2025-11-30', '2025-12-17')
```
Surface excluded count explicitly — never silently drop.

### Step 2 — For remaining moms, check for link-based pattern
```
IF blank updated_by_name rows exist AFTER first engaged_in_program event
   AND those rows do not fall in the 5–6 AM ET scheduled pipeline window
  THEN best_intake_date = MIN(created_at) of those blank rows
  ELSE best_intake_date = first engaged_in_program timestamp
```

### Step 3 — Output three columns for every intake-dependent calculation

| Column | Description |
|---|---|
| `mom_id` | FK to Mom table |
| `best_intake_date` | Corrected intake date using logic above |
| `intake_method` | `ps_migrated` / `coordinator_led` / `link_based` |

---

## Production SQL (PostgreSQL)

```sql
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
  JOIN organic_only oo
    ON oo.mom_id = a.data->>'id'
  WHERE a."table" = 'Mom'
    AND a.action = 'Update'
    AND a.data->>'prospect_status' = 'engaged_in_program'
    AND (a.data->>'updated_by_name' IS NULL
      OR a.data->>'updated_by_name' = '')
    AND a.created_at > oo.coordinator_engaged_date
    AND EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/New_York')
      NOT IN (5, 6)
  GROUP BY a.data->>'id'
)
SELECT
  oo.mom_id,
  oo.coordinator_engaged_date,
  fsc.self_complete_date,
  CASE
    WHEN fsc.self_complete_date IS NOT NULL
      THEN fsc.self_complete_date
    ELSE oo.coordinator_engaged_date
  END AS best_intake_date,
  CASE
    WHEN fsc.self_complete_date IS NOT NULL
      THEN 'link_based'
    ELSE 'coordinator_led'
  END AS intake_method
FROM organic_only oo
LEFT JOIN first_self_complete fsc ON fsc.mom_id = oo.mom_id;
```

---

## Power Query implementation notes

1. Pull `AuditLog` filtered to `table = 'Mom'`, `action = 'Update'`
2. Parse the `data` column as JSON, extract `prospect_status` and `updated_by_name`
3. Filter to rows where `prospect_status = 'engaged_in_program'`
4. Group by `mom_id` (from `data->>'id'`), take `MIN(created_at)` — this is the coordinator timestamp
5. Flag PS-migrated moms where that date falls on **Nov 30 or Dec 17, 2025** — exclude from intake-dependent calculations, surface count explicitly
6. For remaining moms: look for subsequent AuditLog rows on the same mom where `prospect_status = 'engaged_in_program'` AND `updated_by_name` is blank AND hour is not 5 or 6 AM ET
7. Where those blank rows exist, use their `MIN(created_at)` as the real intake date
8. Join final intake date table to `Mom` on `mom_id`
9. Every measure requiring intake date filters to `intake_method != 'ps_migrated'` and surfaces excluded PS count

---

## Intake-dependent calculations

All of the following must draw from `best_intake_date` — never from raw field values:

- Referral conversion rate
- Families Served active-during-period logic
- Q1 Activity — Intakes Completed count
- KPI denominators

---

## Known limitations and caveats

- **Blank `updated_by_name` assumption:** We treat blank `updated_by_name` rows as mom self-completion via intake link. This has been validated against a known link-based intake (Charde Beauduy, Apr 2026) but should be confirmed with engineering — other system processes could theoretically write blank rows.
- **Coordinator sets status before sending link:** In cases where a coordinator sets `engaged_in_program` but then never sends the link (or the mom never completes it), no blank rows will appear and we fall back to the coordinator's premature timestamp. This edge case cannot be fully resolved from AuditLog data alone.
- **FWA timestamp limitation is separate:** `WellnessAssessment.updated_at` resets on any field-level edit — it cannot confirm a full re-assessment. Do not use it as a proxy for intake date.

---

## Recommended long-term fix

Engineering should set `prospect_status = engaged_in_program` **automatically** when the mom submits the intake form, rather than allowing coordinators to set it manually before the form is complete. A dedicated `intake_date` field on the `Mom` table populated at that moment would eliminate this entire derivation and make intake date directly accessible to any reporting tool without requiring AuditLog queries.

---

## Key confirmed values (April 2026)

| Item | Confirmed value |
|---|---|
| Trellis go-live | December 2025 |
| PS migration batch 1 | 2025-11-30 (42 moms) |
| PS migration batch 2 | 2025-12-17 (73 moms) |
| Total PS-migrated | 115 moms |
| `prospect_status` intake value | `engaged_in_program` |
| `prospect_status` pending values | `prospect`, `prospect_intake_scheduled` |
| `prospect_status` non-convert value | `did_not_engage_in_program` |
| AuditLog coverage | 332,961 rows, Nov 2025–present |
| Scheduled pipeline time (exclude) | 5–6 AM ET |
