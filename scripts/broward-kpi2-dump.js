#!/usr/bin/env node
/* ============================================================
   KPI 2 (FSS Improvement) — Broward cohort data dump
   For Cristina, per FSS-broward-cohort-dump-prompt-for-RD.md (5/1/26)
   READ-ONLY. No INSERT/UPDATE/DELETE. No deploy. No code changes
   to routes/report-data.js. Just emits two CSVs locally.

   Usage (from repo root):
     railway run node scripts/broward-kpi2-dump.js
   Writes:
     broward-kpi2-cohort-3mo.csv          (Pull #1)
     broward-kpi2-cohort-comparison.csv   (Pull #2)
   Prints to stdout:
     - Deployed cohort definition (read out of report-data.js logic, not heuristics)
     - Rate (a) on the actual deployed cohort
     - Rate (b) on the intended "new at 3-mo milestone" cohort
   ============================================================ */

const fs = require('fs');
const path = require('path');
const pool = require('../db');

// ─── Period + cohort window constants ────────────────────────
// Q1 2026 reporting period
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-03-31';

// Intended cohort: first engaged ~3 months before period end.
// Cristina's spec: 75–105 days before PERIOD_END, "flex if needed".
// 2026-03-31 minus 105d = 2025-12-16, minus 75d = 2026-01-15
const INTENDED_FIRST_ENGAGED_MIN = '2025-12-16';
const INTENDED_FIRST_ENGAGED_MAX = '2026-01-15';

// Initial FWA: within ±30d of first_engaged
const INITIAL_FWA_DAYS_FROM_INTAKE = 30;
// Milestone FWA: within 60–120d of first_engaged (centered on 90)
const MILESTONE_FWA_DAYS_MIN = 60;
const MILESTONE_FWA_DAYS_MAX = 120;

// PS-migrated batch dates (from existing INTAKE_CTE in report-data.js)
const PS_BATCH_DATES = ["2025-11-30", "2025-12-17"];

// Assessment-role tags written into the Pull #1 CSV
const ROLE_INITIAL       = 'initial';
const ROLE_MILESTONE_3MO = 'milestone_3mo';
const ROLE_DELTA_SUMMARY = 'delta_summary';

// ─── CSV helpers ────────────────────────────────────────────
function csvEsc(v) {
  if (v === null || v === undefined) return '';
  const s = (v instanceof Date) ? v.toISOString() : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((k) => csvEsc(r[k])).join(','));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}
// Privacy-floor initials: first letter of firstName + first letter of lastName, uppercased
function initialsOf(first, last) {
  const f = (first || '').trim();
  const l = (last || '').trim();
  return ((f[0] || '?') + (l[0] || '?')).toUpperCase();
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log('Broward KPI 2 dump — read-only.\n');

  // 1. Probes in parallel: WA columns, ps_params presence, Broward affiliate
  const [colsRes, psParamProbe, browRes] = await Promise.all([
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'WellnessAssessment'`),
    pool.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ltd_people_params') AS present`),
    pool.query(`SELECT "id", "name" FROM "Affiliate" WHERE "deleted_at" = 0 AND LOWER("name") LIKE '%broward%' ORDER BY "name"`),
  ]);
  const waCols = new Set(colsRes.rows.map(r => r.column_name));
  const hasCwScore = waCols.has('cw_score');
  const hasPsParams = psParamProbe.rows[0].present;
  console.log(`WellnessAssessment.cw_score present: ${hasCwScore}`);
  console.log(`WellnessAssessment columns of interest: ${
    ['cpi_total','cw_score','cc_score','ats_score','naa_score','soc_score','res_score',
     'edu_score','ei_score','fin_cpi_sum','home_score','trnprt_score','well_score',
     'completed_ahead','completed_date','last_fwa']
      .filter(c => waCols.has(c)).join(', ')
  }`);
  console.log(`ltd_people_params table present: ${hasPsParams}\n`);

  // SQL fragment for cw_score that degrades gracefully if column is absent
  const cwExpr = hasCwScore ? `wa."cw_score"` : `NULL::numeric`;

  if (browRes.rows.length === 0) {
    console.error('No Broward affiliate found. Aborting.');
    process.exit(1);
  }
  if (browRes.rows.length > 1) {
    console.log('Multiple Broward affiliates found — using first:');
    browRes.rows.forEach(r => console.log(`  ${r.id}  ${r.name}`));
  }
  const browardId   = browRes.rows[0].id;
  const browardName = browRes.rows[0].name;
  console.log(`Broward affiliate: ${browardName} (${browardId})\n`);

  // 3. Print deployed cohort definition (read out of code, not inferred)
  console.log('='.repeat(72));
  console.log('DEPLOYED KPI 2 COHORT DEFINITION (per routes/report-data.js:1293-1345)');
  console.log('='.repeat(72));
  console.log(`
  Source table:        WellnessAssessment (NOT AssessmentResult)
  Eligibility anchor:  any mom with >= 2 WA rows where cpi_total IS NOT NULL
                       (no period anchor, no pairing.completed_on filter,
                       no intake date filter — lifetime)
  Initial FWA:         earliest scored WA per mom (ORDER BY created_at ASC)
  Most-recent FWA:     latest scored WA per mom   (ORDER BY created_at DESC)
  FSS formula:         ats_score + cc_score + edu_score + ei_score + fin_cpi_sum
                     + home_score + naa_score + res_score + soc_score
                     + trnprt_score + well_score   (11 domains, max 356)
  cw_score:            EXCLUDED from FSS (Child Welfare tracked under KPI 1)
  cpi_total:           NOT used in the composite (per V3 comment: "turned out
                       to not be a clean sum of domain scores")
  Single-WA moms:      excluded (wa_count >= 2 required)
  PS-migrated moms:    NOT excluded — any WA with cpi_total NOT NULL counts.
                       Whether PS rows actually live in WellnessAssessment is
                       a separate question; the deployed query does not exclude
                       them by source.
  Numerator:           moms where post_fss > pre_fss (strict >)
`);

  // PS detection uses two signals:
  //   (a) the existing batch-date heuristic (2025-11-30 / 2025-12-17)
  //   (b) ltd_people_params.param_name='intake_form' predating Trellis launch (2025-12-01)
  const psParamCte = hasPsParams ? `
    , ps_param AS (
      SELECT lpp."person_id" AS mom_id, MIN(lpp."created_at") AS ps_intake_at
      FROM "ltd_people_params" lpp
      WHERE lpp."param_name" = 'intake_form'
      GROUP BY lpp."person_id"
    )` : `, ps_param AS (SELECT NULL::text AS mom_id, NULL::timestamptz AS ps_intake_at LIMIT 0)`;

  const deployedQ = `
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
        COUNT(*)        OVER (PARTITION BY wa."mom_id") AS wa_count
      FROM "WellnessAssessment" wa
      JOIN "Mom" m ON m."id" = wa."mom_id"
      WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
        AND wa."cpi_total" IS NOT NULL
        AND m."affiliate_id" = $1
    ),
    mom_pre_post AS (
      SELECT "mom_id",
             MAX(CASE WHEN rn_asc  = 1 THEN fss_total END) AS pre_fss,
             MAX(CASE WHEN rn_desc = 1 THEN fss_total END) AS post_fss,
             MAX(wa_count) AS wa_count
      FROM scored_was
      GROUP BY "mom_id"
    )
    SELECT COUNT(*)::int AS denom,
           SUM(CASE WHEN post_fss > pre_fss THEN 1 ELSE 0 END)::int AS num
    FROM mom_pre_post
    WHERE wa_count >= 2 AND pre_fss IS NOT NULL AND post_fss IS NOT NULL
  `;

  const cohortBaseQ = `
    WITH first_engaged AS (
      SELECT data->>'id' AS mom_id, MIN(created_at) AS coordinator_engaged_date
      FROM "AuditLog"
      WHERE "table" = 'Mom' AND action = 'Update'
        AND data->>'prospect_status' = 'engaged_in_program'
      GROUP BY data->>'id'
    )
    ${psParamCte}
    SELECT
      m."id"          AS mom_id,
      m."first_name" AS "firstName",
      m."last_name"  AS "lastName",
      m."status"::text AS mom_status,
      m."prospect_status"::text AS prospect_status,
      m."affiliate_id" AS affiliate_id,
      fe.coordinator_engaged_date AS first_engaged_at,
      pp.ps_intake_at,
      CASE
        WHEN fe.coordinator_engaged_date IS NULL AND pp.ps_intake_at IS NOT NULL
          THEN 'PS-migrated'
        WHEN fe.coordinator_engaged_date IS NOT NULL
             AND DATE_TRUNC('day', fe.coordinator_engaged_date) IN ('2025-11-30','2025-12-17')
          THEN 'PS-migrated'
        WHEN pp.ps_intake_at IS NOT NULL AND pp.ps_intake_at < '2025-12-01'
          THEN 'PS-migrated'
        WHEN fe.coordinator_engaged_date IS NOT NULL AND fe.coordinator_engaged_date >= '2025-12-01'
          THEN 'Trellis-native new'
        WHEN fe.coordinator_engaged_date IS NOT NULL AND fe.coordinator_engaged_date <  '2025-12-01'
          THEN 'ambiguous'
        ELSE 'ambiguous'
      END AS cohort_status,
      (SELECT COUNT(*)::int FROM "Pairing" p
        WHERE p."momId" = m."id" AND p."deleted_at" = 0) AS pairing_count,
      (SELECT MAX(p."completed_on") FROM "Pairing" p
        WHERE p."momId" = m."id" AND p."deleted_at" = 0) AS most_recent_pairing_completed_on,
      (SELECT p."status"::text FROM "Pairing" p
        WHERE p."momId" = m."id" AND p."deleted_at" = 0
        ORDER BY p."created_at" DESC LIMIT 1) AS most_recent_pairing_status
    FROM "Mom" m
    LEFT JOIN first_engaged fe ON fe.mom_id = m."id"
    LEFT JOIN ps_param pp ON pp.mom_id = m."id"
    WHERE m."deleted_at" = 0 AND m."affiliate_id" = $1
  `;

  const waQ = `
    SELECT
      wa."id"          AS wa_id,
      wa."mom_id",
      wa."created_at",
      wa."updated_at",
      wa."last_fwa",
      wa."completed_ahead",
      wa."completed_date",
      wa."cpi_total",
      ${cwExpr}        AS cw_score,
      wa."cc_score",
      wa."ats_score",
      wa."naa_score",
      wa."soc_score",
      wa."res_score",
      wa."edu_score",
      wa."ei_score",
      wa."fin_cpi_sum",
      wa."home_score",
      wa."trnprt_score",
      wa."well_score"
    FROM "WellnessAssessment" wa
    JOIN "Mom" m ON m."id" = wa."mom_id"
    WHERE wa."deleted_at" = 0 AND m."deleted_at" = 0
      AND m."affiliate_id" = $1
    ORDER BY wa."mom_id", wa."created_at" ASC
  `;

  const [depRes, cohortRes, waRes] = await Promise.all([
    pool.query(deployedQ,   [browardId]),
    pool.query(cohortBaseQ, [browardId]),
    pool.query(waQ,         [browardId]),
  ]);
  const dep        = depRes.rows[0];
  const cohortRows = cohortRes.rows;
  const waRows     = waRes.rows;

  console.log(`Broward moms in cohort base: ${cohortRows.length}`);
  const cohortByStatus = cohortRows.reduce((acc, r) => {
    acc[r.cohort_status] = (acc[r.cohort_status] || 0) + 1; return acc;
  }, {});
  console.log(`  cohort_status breakdown: ${JSON.stringify(cohortByStatus)}`);
  console.log(`Broward WellnessAssessment rows: ${waRows.length}\n`);

  const wasByMom = waRows.reduce((acc, r) => {
    (acc[r.mom_id] = acc[r.mom_id] || []).push(r); return acc;
  }, {});

  // ─── Composite + per-row helpers ────────────────────────────
  const SCORE_KEYS = ['cpi_total','cw_score','cc_score','ats_score','naa_score','soc_score','res_score',
                      'edu_score','ei_score','fin_cpi_sum','home_score','trnprt_score','well_score'];
  function num(v) { return v === null || v === undefined ? null : Number(v); }
  function compositeCristina(r) {
    // cpi_total - cw_score + ats_score + naa_score + soc_score + res_score
    const parts = [r.cpi_total, r.cw_score === null ? 0 : -r.cw_score,
                   r.ats_score, r.naa_score, r.soc_score, r.res_score];
    if (parts.some(v => v === null || v === undefined)) return null;
    return parts.reduce((a,b) => a + Number(b), 0);
  }
  function compositeDeployed(r) {
    const keys = ['ats_score','cc_score','edu_score','ei_score','fin_cpi_sum','home_score',
                  'naa_score','res_score','soc_score','trnprt_score','well_score'];
    let sum = 0; let anyNonNull = false;
    for (const k of keys) {
      if (r[k] !== null && r[k] !== undefined) { sum += Number(r[k]); anyNonNull = true; }
    }
    return anyNonNull ? sum : null;
  }
  function domainsPopulated(r) {
    return SCORE_KEYS.filter(k => r[k] !== null && r[k] !== undefined).length;
  }
  function daysBetween(a, b) {
    if (!a || !b) return null;
    return Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
  }

  // 7. PULL #1 — Broward "new" cohort at 3-month milestone
  //    For each cohort-eligible mom, pick initial WA + milestone WA.
  //    Mom is eligible if:
  //      - first_engaged_at in [INTENDED_FIRST_ENGAGED_MIN, INTENDED_FIRST_ENGAGED_MAX]
  //      - prior_track_count = 1 (proxy for "first engagement only")
  //      - has at least one WA within ±30d of intake (initial)
  //      - has at least one WA in [intake+60d, intake+120d] (milestone)
  const pull1Rows = [];
  const pull1MomSet = new Set();
  for (const m of cohortRows) {
    if (!m.first_engaged_at) continue;
    const fe = new Date(m.first_engaged_at);
    const inWindow = fe >= new Date(INTENDED_FIRST_ENGAGED_MIN)
                   && fe <= new Date(INTENDED_FIRST_ENGAGED_MAX + 'T23:59:59');
    if (!inWindow) continue;
    if (m.cohort_status === 'PS-migrated') continue; // Cristina: PS flagged separate, exclude from intended
    if (m.pairing_count > 1) continue; // multi-track exclusion proxy

    const mWas = (wasByMom[m.mom_id] || []).filter(w => w.cpi_total !== null);
    if (mWas.length === 0) continue;

    // initial = WA closest to intake (within +/- 30d)
    const initialCandidates = mWas
      .map(w => ({ ...w, _dDays: Math.abs(daysBetween(fe, w.created_at)) }))
      .filter(w => w._dDays <= INITIAL_FWA_DAYS_FROM_INTAKE);
    const initial = initialCandidates.sort((a,b) => a._dDays - b._dDays)[0];

    // milestone = WA in [intake+60d, intake+120d], closest to intake+90d
    const milestoneCandidates = mWas
      .map(w => ({ ...w, _days: daysBetween(fe, w.created_at) }))
      .filter(w => w._days >= MILESTONE_FWA_DAYS_MIN && w._days <= MILESTONE_FWA_DAYS_MAX);
    const milestone = milestoneCandidates.sort((a,b) => Math.abs(a._days - 90) - Math.abs(b._days - 90))[0];

    if (!initial || !milestone) continue;
    if (initial.wa_id === milestone.wa_id) continue; // need 2 distinct rows

    pull1MomSet.add(m.mom_id);
    const baseRow = {
      mom_id: m.mom_id,
      mom_initials: initialsOf(m.firstName, m.lastName),
      cohort_status: m.cohort_status,
      first_engaged_at: m.first_engaged_at,
    };
    for (const w of [initial, milestone]) {
      pull1Rows.push({
        ...baseRow,
        days_at_program_at_assessment: daysBetween(fe, w.created_at),
        assessment_role: w.wa_id === initial.wa_id ? ROLE_INITIAL : ROLE_MILESTONE_3MO,
        assessment_date: w.created_at,
        track_status_at_assessment: '',  // populated below per pairing-window join
        cpi_total: num(w.cpi_total),
        cw_score:  num(w.cw_score),
        cc_score:  num(w.cc_score),
        ats_score: num(w.ats_score),
        naa_score: num(w.naa_score),
        soc_score: num(w.soc_score),
        res_score: num(w.res_score),
        edu_score: num(w.edu_score),
        ei_score:  num(w.ei_score),
        fin_cpi_sum: num(w.fin_cpi_sum),
        home_score:  num(w.home_score),
        trnprt_score: num(w.trnprt_score),
        well_score:  num(w.well_score),
        composite_cristina: compositeCristina(w),
        composite_deployed: compositeDeployed(w),
        domains_populated_count: domainsPopulated(w),
        last_field_updated_at: w.updated_at,
        assessment_created_at: w.created_at,
        wa_id: w.wa_id,
        window_days: '',
        cohort_note: '',
      });
    }
    // Summary delta row
    const delta = (k) => {
      const a = num(initial[k]); const b = num(milestone[k]);
      return (a === null || b === null) ? null : (b - a);
    };
    pull1Rows.push({
      ...baseRow,
      days_at_program_at_assessment: '',
      assessment_role: ROLE_DELTA_SUMMARY,
      assessment_date: '',
      track_status_at_assessment: '',
      cpi_total: delta('cpi_total'),
      cw_score:  delta('cw_score'),
      cc_score:  delta('cc_score'),
      ats_score: delta('ats_score'),
      naa_score: delta('naa_score'),
      soc_score: delta('soc_score'),
      res_score: delta('res_score'),
      edu_score: delta('edu_score'),
      ei_score:  delta('ei_score'),
      fin_cpi_sum: delta('fin_cpi_sum'),
      home_score:  delta('home_score'),
      trnprt_score: delta('trnprt_score'),
      well_score:  delta('well_score'),
      composite_cristina: (compositeCristina(milestone) === null || compositeCristina(initial) === null)
        ? null : (compositeCristina(milestone) - compositeCristina(initial)),
      composite_deployed: (compositeDeployed(milestone) === null || compositeDeployed(initial) === null)
        ? null : (compositeDeployed(milestone) - compositeDeployed(initial)),
      domains_populated_count: '',
      last_field_updated_at: '',
      assessment_created_at: '',
      wa_id: '',
      window_days: daysBetween(initial.created_at, milestone.created_at),
      cohort_note: '',
    });
  }

  // 7b. Annotate track_status_at_assessment using Pairing windows
  // For each WA row in pull1Rows (skip the delta_summary rows),
  // find any pairing for that mom whose window contains the assessment_date.
  const dataRowMomIds = [...new Set(pull1Rows.filter(r => r.assessment_role !== ROLE_DELTA_SUMMARY).map(r => r.mom_id))];
  if (dataRowMomIds.length > 0) {
    const pairingsRes = await pool.query(`
      SELECT p."momId" AS mom_id, p."created_at", p."completed_on", p."status"::text AS status,
             t."title" AS program_name
      FROM "Pairing" p
      LEFT JOIN "Track" t ON t."id" = p."trackId"
      WHERE p."deleted_at" = 0 AND p."momId" = ANY($1::text[])
      ORDER BY p."created_at"
    `, [dataRowMomIds]);
    const pairingsByMom = {};
    for (const p of pairingsRes.rows) (pairingsByMom[p.mom_id] = pairingsByMom[p.mom_id] || []).push(p);
    for (const r of pull1Rows) {
      if (r.assessment_role === ROLE_DELTA_SUMMARY) continue;
      const ps = pairingsByMom[r.mom_id] || [];
      const t = new Date(r.assessment_date);
      let inWindow = null;
      for (const p of ps) {
        const start = new Date(p.created_at);
        const end = p.completed_on ? new Date(p.completed_on) : new Date('9999-12-31');
        if (t >= start && t <= end) { inWindow = p; break; }
      }
      if (inWindow) r.track_status_at_assessment = `in-track (${inWindow.program_name || 'unknown'})`;
      else if (ps.length === 0 || t < new Date(ps[0].created_at)) r.track_status_at_assessment = 'pre-track';
      else r.track_status_at_assessment = 'between-tracks';
    }
  }

  // 8. PULL #2 — comparison: deployed-actual vs intended cohort
  //
  //   Deployed-actual cohort (per code as deployed): Broward moms with >= 2 scored WAs.
  //   Intended cohort: pull1MomSet (the moms who landed in Pull #1).
  //
  //   Group A: in deployed-actual but NOT in intended  → why: not new, multi-track,
  //            intake out of window, or PS-migrated, etc.
  //   Group B: in intended but NOT in deployed-actual  → why: <2 scored WAs etc.
  //   Group C: almost-eligible new moms (in intake window + first engagement) but
  //            failed Pull #1 due to FWA gaps (only 1 WA, only legacy, etc).
  const scoredCountByMom = {};
  const wellnessCountByMom = {};
  const earliestByMom = {};
  const latestByMom = {};
  for (const w of waRows) {
    wellnessCountByMom[w.mom_id] = (wellnessCountByMom[w.mom_id] || 0) + 1;
    if (w.cpi_total !== null) scoredCountByMom[w.mom_id] = (scoredCountByMom[w.mom_id] || 0) + 1;
    const t = new Date(w.created_at);
    if (!earliestByMom[w.mom_id] || t < new Date(earliestByMom[w.mom_id])) earliestByMom[w.mom_id] = w.created_at;
    if (!latestByMom[w.mom_id]   || t > new Date(latestByMom[w.mom_id]))   latestByMom[w.mom_id]   = w.created_at;
  }
  const deployedActualSet = new Set(Object.keys(scoredCountByMom).filter(k => scoredCountByMom[k] >= 2));

  const pull2Rows = [];
  const intendedSet = pull1MomSet;
  const periodEndDate = new Date(PERIOD_END + 'T23:59:59');
  for (const m of cohortRows) {
    const inDeployed = deployedActualSet.has(m.mom_id);
    const inIntended = intendedSet.has(m.mom_id);
    const fe = m.first_engaged_at ? new Date(m.first_engaged_at) : null;
    const inIntakeWindow = fe
      && fe >= new Date(INTENDED_FIRST_ENGAGED_MIN)
      && fe <= new Date(INTENDED_FIRST_ENGAGED_MAX + 'T23:59:59')
      && m.pairing_count <= 1
      && m.cohort_status !== 'PS-migrated';

    let group = null;
    let reason = '';

    if (inDeployed && !inIntended) {
      group = 'A';
      const reasons = [];
      if (m.cohort_status === 'PS-migrated') reasons.push('PS-migrated');
      if (!fe) reasons.push('no engaged_in_program audit');
      else {
        if (fe < new Date(INTENDED_FIRST_ENGAGED_MIN)) reasons.push('intake too far back (>105d before period end)');
        if (fe > new Date(INTENDED_FIRST_ENGAGED_MAX + 'T23:59:59')) reasons.push('intake too recent (<75d before period end)');
      }
      if (m.pairing_count > 1) reasons.push(`multi-track / multi-pairing (${m.pairing_count} pairings)`);
      const mWas = (wasByMom[m.mom_id] || []).filter(w => w.cpi_total !== null);
      if (fe && mWas.length >= 2) {
        const earliestDays = daysBetween(fe, mWas[0].created_at);
        const latestDays = daysBetween(fe, mWas[mWas.length - 1].created_at);
        if (Math.abs(earliestDays) > INITIAL_FWA_DAYS_FROM_INTAKE) reasons.push(`earliest scored WA not near intake (${earliestDays}d off)`);
        if (latestDays < MILESTONE_FWA_DAYS_MIN || latestDays > MILESTONE_FWA_DAYS_MAX) reasons.push(`latest scored WA not in milestone window (${latestDays}d post-intake)`);
      }
      if (reasons.length === 0) reasons.push('unknown — investigate');
      reason = reasons.join('; ');
    } else if (!inDeployed && inIntended) {
      group = 'B'; // shouldn't happen given how Pull #1 is constructed, but include for completeness
      reason = 'fits intended cohort but <2 scored WAs in deployed denominator (cpi_total NULL or single WA)';
    } else if (!inDeployed && !inIntended && fe && inIntakeWindow) {
      // Group C: almost-eligible — fits intake + first-engagement criteria but failed FWA test
      group = 'C';
      const reasons = [];
      const mWas = wasByMom[m.mom_id] || [];
      const scoredWas = mWas.filter(w => w.cpi_total !== null);
      if (mWas.length === 0) reasons.push('no WellnessAssessment rows on file');
      else if (scoredWas.length === 0) reasons.push(`${mWas.length} WA row(s) on file but none scored (cpi_total NULL)`);
      else if (scoredWas.length === 1) {
        const dt = daysBetween(fe, scoredWas[0].created_at);
        reasons.push(`only 1 scored WA on file (${dt}d post-intake)`);
      } else {
        const initialCandidates = scoredWas.filter(w => Math.abs(daysBetween(fe, w.created_at)) <= INITIAL_FWA_DAYS_FROM_INTAKE);
        const milestoneCandidates = scoredWas.filter(w => {
          const d = daysBetween(fe, w.created_at);
          return d >= MILESTONE_FWA_DAYS_MIN && d <= MILESTONE_FWA_DAYS_MAX;
        });
        if (initialCandidates.length === 0) reasons.push(`no scored WA within ±${INITIAL_FWA_DAYS_FROM_INTAKE}d of intake`);
        if (milestoneCandidates.length === 0) {
          const offsets = scoredWas.map(w => daysBetween(fe, w.created_at)).join(',');
          reasons.push(`no scored WA in [${MILESTONE_FWA_DAYS_MIN}-${MILESTONE_FWA_DAYS_MAX}]d post-intake (offsets: ${offsets})`);
        }
      }
      if (reasons.length === 0) reasons.push('unknown — investigate');
      reason = reasons.join('; ');
    }

    if (!group) continue;

    pull2Rows.push({
      mom_id: m.mom_id,
      mom_initials: initialsOf(m.firstName, m.lastName),
      cohort_status: m.cohort_status,
      comparison_group: group,
      first_engaged_at: m.first_engaged_at,
      days_at_program_at_period_end: fe ? daysBetween(fe, periodEndDate) : null,
      most_recent_pairing_status: m.most_recent_pairing_status || '',
      most_recent_pairing_completed_on: m.most_recent_pairing_completed_on || '',
      pairing_count: m.pairing_count,
      wellness_assessment_count: wellnessCountByMom[m.mom_id] || 0,
      scored_assessment_count: scoredCountByMom[m.mom_id] || 0,
      earliest_assessment_date: earliestByMom[m.mom_id] || '',
      most_recent_assessment_date: latestByMom[m.mom_id] || '',
      mom_status_now: m.mom_status,
      prospect_status_now: m.prospect_status,
      reason,
    });
  }

  // 9. Compute intended-cohort rate
  const pull1RowsByMom = pull1Rows.reduce((acc, r) => {
    (acc[r.mom_id] = acc[r.mom_id] || []).push(r); return acc;
  }, {});
  let intendedNum = 0, intendedDenom = 0;
  for (const momId of pull1MomSet) {
    const momRows = (pull1RowsByMom[momId] || []).filter(r => r.assessment_role !== ROLE_DELTA_SUMMARY);
    if (momRows.length !== 2) continue;
    intendedDenom++;
    const initial   = momRows.find(r => r.assessment_role === ROLE_INITIAL);
    const milestone = momRows.find(r => r.assessment_role === ROLE_MILESTONE_3MO);
    if (initial.composite_deployed !== null && milestone.composite_deployed !== null
        && milestone.composite_deployed > initial.composite_deployed) {
      intendedNum++;
    }
  }

  // 10. Write CSVs
  const outDir = process.cwd();
  const pull1Path = path.join(outDir, 'broward-kpi2-cohort-3mo.csv');
  const pull2Path = path.join(outDir, 'broward-kpi2-cohort-comparison.csv');

  const pull1Header = [
    'mom_id','mom_initials','cohort_status','first_engaged_at',
    'days_at_program_at_assessment','assessment_role','assessment_date',
    'track_status_at_assessment',
    'cpi_total','cw_score','cc_score','ats_score','naa_score','soc_score','res_score',
    'edu_score','ei_score','fin_cpi_sum','home_score','trnprt_score','well_score',
    'composite_cristina','composite_deployed',
    'domains_populated_count','last_field_updated_at','assessment_created_at',
    'wa_id','window_days','cohort_note',
  ];
  const pull2Header = [
    'mom_id','mom_initials','cohort_status','comparison_group',
    'first_engaged_at','days_at_program_at_period_end',
    'most_recent_pairing_status','most_recent_pairing_completed_on','pairing_count',
    'wellness_assessment_count','scored_assessment_count',
    'earliest_assessment_date','most_recent_assessment_date',
    'mom_status_now','prospect_status_now','reason',
  ];
  writeCsv(pull1Path, pull1Header, pull1Rows);
  writeCsv(pull2Path, pull2Header, pull2Rows);

  // 11. Print summary
  console.log('='.repeat(72));
  console.log('RATES');
  console.log('='.repeat(72));
  const rate = (n, d) => d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
  console.log(`(a) Actual deployed rate (Broward, lifetime ≥2 scored WAs):`);
  console.log(`    ${dep.num} of ${dep.denom} = ${rate(dep.num, dep.denom)}`);
  console.log(`(b) Intended cohort rate (Broward, "new at 3-mo milestone"):`);
  console.log(`    ${intendedNum} of ${intendedDenom} = ${rate(intendedNum, intendedDenom)}`);
  console.log('');
  console.log('='.repeat(72));
  console.log('FILES WRITTEN');
  console.log('='.repeat(72));
  console.log(`  ${pull1Path}      (${pull1Rows.length} rows including delta summaries)`);
  console.log(`  ${pull2Path}      (${pull2Rows.length} rows; A/B/C breakdown below)`);
  const groupCounts = pull2Rows.reduce((a, r) => { a[r.comparison_group] = (a[r.comparison_group] || 0) + 1; return a; }, {});
  console.log(`    A: ${groupCounts.A || 0}   B: ${groupCounts.B || 0}   C: ${groupCounts.C || 0}`);
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('Dump failed:', err);
  process.exit(1);
});
