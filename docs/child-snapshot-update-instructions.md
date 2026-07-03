# Child Snapshot Update Instructions
**For: RD | Updated: July 2026**

---

## What this is

The child snapshot is a point-in-time export of every child record in Trellis.
It powers two things in the Impact Hub:
1. The **Child Welfare Status Review** report (intake welfare status per child)
2. The **Q2 KPI 1 (Family Preservation Rate)** calculation

The snapshot is a JSON file stored in the repo at `data/child-snapshot.json`.
When you send an updated CSV, Cristina passes it to the dev team to replace that file.

---

## When to update

- Whenever corrections have been made to child welfare status records in Trellis
- At minimum: once after June 30 to lock the Q2 period data
- Next expected update: **by July 8, 2026**

---

## What to export

Run the same Supabase query used to produce `ChildSnapshot_rows_updated7.30.csv`.

The export must include these columns in this order:

| Column | Source |
|---|---|
| `id` | ChildSnapshot.id |
| `child_id` | ChildSnapshot.child_id |
| `mom_id` | ChildSnapshot.mom_id |
| `affiliate_id` | ChildSnapshot.affiliate_id |
| `snapshot_date` | ChildSnapshot.snapshot_date |
| `snapshot_trigger` | ChildSnapshot.snapshot_trigger |
| `changed_by_id` | ChildSnapshot.changed_by_id |
| `changed_by_name` | ChildSnapshot.changed_by_name |
| `child_updated_at` | ChildSnapshot.child_updated_at |
| `first_name` | ChildSnapshot.first_name |
| `gender` | ChildSnapshot.gender |
| `birthdate` | ChildSnapshot.birthdate |
| `lives_with` | ChildSnapshot.lives_with |
| `legal_custody_status` | ChildSnapshot.legal_custody_status |
| `active_child_welfare_involvement` | ChildSnapshot.active_child_welfare_involvement |
| `family_preservation_goal` | ChildSnapshot.family_preservation_goal |
| `family_preservation_impact` | ChildSnapshot.family_preservation_impact |
| `father_involved` | ChildSnapshot.father_involved |
| `father_involvement` | ChildSnapshot.father_involvement |
| `additional_info` | ChildSnapshot.additional_info |
| `created_at` | ChildSnapshot.created_at |

**Scope: all affiliates, all active children (deleted_at = 0).**

---

## What to check before sending

1. Row count is **≥ 622** (the July 30 export had 622 rows — new rows may be added)
2. No rows are missing `child_id` or `mom_id`
3. `active_child_welfare_involvement` is populated for all rows where the child has a known welfare status

---

## How to send

Name the file: `ChildSnapshot_rows_updated_MMDD.csv` (e.g. `ChildSnapshot_rows_updated_0708.csv`)

Send to Cristina. She will pass it to the dev team to update the Impact Hub.

---

## What happens after you send it

The dev team will:
1. Replace `data/child-snapshot.json` with the new data
2. Deploy to Railway
3. The Child Welfare Status Review and Q2 KPI 1 will reflect the updated records immediately

No other action needed from you.

---

## Notes

- The `family_preservation_goal` and `family_preservation_impact` columns are included in the export but the Impact Hub recalculates these from `active_child_welfare_involvement` using its own mapping logic. You do not need to correct those fields manually — focus corrections on `active_child_welfare_involvement`.
- If a child's welfare status was corrected in Trellis after the last export, it will appear in the updated snapshot automatically.
- Children added to Trellis after the last export will appear as new rows.
