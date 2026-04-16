# ĒMA Impact Hub — To Do List
**Last updated:** April 16, 2026

---

## RD Tasks — Blocking

### 1. Intake date: spot-check output across all three populations
Implementation matches documented spec (posted Tue 4/15). Need a quick spot-check: pick a few moms from each population (coordinator-led, link-based, PS-migrated) in the live `/api/report-data` output and confirm dates look right. Cross-check: Families Served count, Referral Conversion Rate denominator.
- [ ] Spot-check coordinator-led moms
- [ ] Spot-check link-based moms
- [ ] Spot-check PS-migrated moms (should be excluded)
- [ ] Cross-check Families Served count
- [ ] Cross-check Referral Conversion Rate denominator

*Owner: RD*

### 2. KPI 1: Confirm API implements Prevention % methodology
Numerator = children where `family_preservation_impact` is one of:
- `prevented_from_cps_involvement`
- `prevented_from_foster_care_placement`

That's it. Only those two. Everything else (`prevented_from_permanent_removal`, `temporary_removal`, `permanent_removal`) is in the denominator but NOT the numerator.

Denominator = all children linked to moms with a valid in-window FWA.
Surface excluded count (children whose moms have no current FWA).

Run `SELECT DISTINCT family_preservation_impact FROM "Child"` to confirm exact enum values.

**Current API uses `IS DISTINCT FROM 'permanent_removal'` which is WRONG — needs to be updated to only count the two prevention values.**

Reference: Family Preservation Impact methodology

- [ ] Fix KPI 1 numerator query in `routes/report-data.js`
- [ ] Verify with `SELECT DISTINCT` on live DB
- [ ] Confirm excluded count surfaces correctly

*Owner: RD*

### 3. KPI 1: Confirm CW side-tab edits don't retroactively change completed assessments
When a coordinator edits a child's Active Child Welfare Involvement from the Child Profile side tab (not through the FWA), does it retroactively update `cw_fp_goal` / `cw_fp_impact` on already-completed `WellnessAssessment` records? Or only the Child record and future assessments?
- If **not retroactive**: completed assessments are reliable snapshots, no action needed.
- If **retroactive**: we have a data integrity issue and need AuditLog to recover initial values.

- [ ] Test in Trellis: edit a child's CW involvement, check if completed WellnessAssessment changes
- [ ] Document finding

*Owner: RD*

### 4. KPI 2: Apply corrected FSS formula
Replace any use of Trellis `cpi_total` for FSS with:
```
ĒMA_FSS = cpi_total - cw_score + ats_score + naa_score + soc_score + res_score
```
All fields on the same `WellnessAssessment` row. Apply to both initial and latest assessment records before comparing. Jean's assessment-pairing logic doesn't change. Only the score being compared changes.

**Why:** `cpi_total` includes `cw_score` (should be excluded — feeds KPI 1 not KPI 2) and omits 4 PFS-scaled domains (`ats`, `naa`, `soc`, `res`) that ĒMA needs in the composite.

Source: `Family_Wellbeing_Assessment_For_DCF_2026_04.xlsx`, Part II tab.

- [ ] Identify WellnessAssessment fields: `cpi_total`, `cw_score`, `ats_score`, `naa_score`, `soc_score`, `res_score`
- [ ] Update KPI 2 query in `routes/report-data.js`
- [ ] Verify pre vs post comparison uses corrected formula

*Owner: RD + Cristina*

### 5. Move dashboard to everymothersadvocate.org domain
Currently at `web-production-6efb7.up.railway.app`. Steps:
1. Add custom domain in Railway service settings
2. Add CNAME record in GoDaddy DNS for `everymothersadvocate.org`
3. Railway handles SSL automatically

Need to work with Cristina on GoDaddy access for the domain.

- [ ] Choose subdomain (e.g. `impact.everymothersadvocate.org`)
- [ ] Get GoDaddy DNS access from Cristina
- [ ] Add custom domain in Railway
- [ ] Add CNAME record in GoDaddy
- [ ] Verify SSL + domain works

*Owner: RD (needs Cristina for GoDaddy access)*

### 6. SendGrid domain authentication
Add CNAME records to `ema.org` DNS so Champion invite/reset emails deliver. Currently logging to Railway console as workaround. Requires same DNS access as task #5.

- [ ] Go to SendGrid → Sender Authentication → Authenticate Domain
- [ ] Add `ema.org`, get CNAME records
- [ ] Add records in DNS provider
- [ ] Verify in SendGrid
- [ ] Test Champion invite email delivery

*Owner: RD (needs DNS access)*

---

## Cristina Tasks — Waiting on Input

- [ ] **Staff headcount** — Not in Trellis. Need definition (coordinators only vs broader) and source (HR/finance). Needed for moms-per-staff and advocates-per-staff ratios.
- [ ] **Cost Per Family** — Q1 program spend not in Trellis. Finance must provide. Confirm scope: direct program costs only or fully loaded?
- [ ] **KPI 2 formula sign-off** — Confirm the corrected ĒMA FSS formula above is correct before RD implements.
- [ ] **GoDaddy DNS access** — RD needs access to add CNAME records for custom domain + SendGrid.

---

## Performance — Planned

- [ ] **DB connection warm-up** — Fire `SELECT 1` on server start to pre-warm the pg Pool. First request currently pays ~500ms connection cost. *Quick win*
- [ ] **Cache report-data for 5 minutes** — Store `/api/report-data` response in memory keyed by affiliate. Serve instantly on repeat visits. Clear every 5 min. *Biggest impact on load time*
- [ ] **Progressive loading** — Split into `/api/report-data/summary` (fast KPIs) and `/api/report-data/detail` (heavy queries). User sees numbers immediately while rest fills in. *Follow-up after caching*

---

## Data Gaps — Blocked on External

- [ ] **Service Connection Rate** — `connected_*` boolean fields on Mom record are all empty (0 across all 9 fields). Only 14 ServiceReferral records exist. Deferred to live coordinator dashboards. *Blocked on Trellis data entry*

---

## Feature — Future Build

- [ ] **SheetJS self-host** — If Cristina adds Excel export to quarterly report, may need to self-host `xlsx.full.min.js` instead of CDN. Not referenced yet.
- [ ] **Multi-select affiliate slicer** — Currently single-select. Would need API to accept `?affiliate_id=id1,id2`, custom dropdown UI, queries with `IN (...)`. *Parked for now*
- [ ] **Period selector** — Currently hardcoded to Q1 2026. Need to support Q2, Q3, etc. Requires parameterizing PERIOD_START/PERIOD_END in API.
- [ ] **Monthly Impact Report** — Hub card shows "Coming Soon". Same structure as quarterly, scoped to single month.
- [ ] **Program Pulse (live dashboard)** — Hub card shows "Coming Soon". Real-time operational view.
- [ ] **Affiliate Overview** — Hub card shows "Coming Soon" (HQ Admin only). Cross-affiliate comparison.
- [ ] **Data Integrity Reports** — Hub card shows "Coming Soon" (HQ Admin only).
- [ ] **Referral Reports** — Hub card shows "Coming Soon".
- [ ] **Mom Reports** — Hub card shows "Coming Soon".
- [ ] **Service and Support Reports** — Hub card shows "Coming Soon".
- [ ] **Grant Snapshot** — Hub card shows "Coming Soon". Outward-facing.
- [ ] **Community Partner Summary** — Hub card shows "Coming Soon".

---

## Known Limitations — Documented

- **FWA timestamp bug** — Any field-level edit to an FWA updates the full submission timestamp. "Current" FWA may not mean a full re-assessment was conducted. No technical fix — Trellis platform limitation. Documented in CLAUDE.md.
- **Sessions in-memory** — Express sessions stored in memory. Users must re-login after every Railway redeploy. Consider connect-pg-simple for persistent sessions if this becomes painful.
- **PS-migrated moms (115)** — Excluded from intake-dependent calculations. Nov 30 + Dec 17 2025 migration batches have artificial timestamps, not real intake dates.
- **Advocate sub-status mismatches** — 47 advocates have Active+Paired but no active pairing (or vice versa). Corrected server-side in `/api/advocates` with `mismatchFlag`. Root cause is manual status updates in Trellis.

---

## Completed ✅

- [x] Login + role-based access (Trellis auth)
- [x] Champion auth system (separate table, invite/reset emails, admin panel)
- [x] Impact Hub landing page (Cristina's design)
- [x] Q1 2026 Program Oversight Report (all tabs, live data)
- [x] Advocate Care Report (live data, filtering, HIPAA export)
- [x] KPI 1/2/3 gauge calculations (needs formula corrections — see RD tasks 2 + 4)
- [x] Intake date methodology (AuditLog-derived)
- [x] Affiliate scoping (admin→all, coordinator→own, supervisor→affiliate, champion→flexible)
- [x] "All Affiliates except Broward" slicer option
- [x] Loading spinner (no flash of sample data)
- [x] Parallelized report-data queries (34 queries via Promise.all)
- [x] Lightweight /api/affiliates endpoint
- [x] Zebra-striping on all tables
- [x] deriveSub server-side (advocate sub-status correction)
- [x] AdvocacyGroup integration (group facilitators)
- [x] Data integrity page (/integrity)
- [x] CLAUDE.md blueprint (full project docs)
- [x] Railway deployment
- [x] GitHub repo (ema1_admin/ema-kpi)
