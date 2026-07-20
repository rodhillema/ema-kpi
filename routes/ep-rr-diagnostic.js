/* ============================================================
   /api/ep-rr-diagnostic
   EP/RR Learning KPI Diagnostic - instrument and scoring audit.
   Administrator only (Cristina). Returns all data for the
   diagnostic report page in one JSON envelope.
   ============================================================ */

'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const DATA_START = '2026-01-01';
const DATA_END   = '2026-06-30'; // Q2 YTD — matches quarterly KPI reporting window

const pf = (v, d = 2) => v == null ? null : parseFloat(parseFloat(v).toFixed(d));

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'administrator') return next();
  return res.status(403).json({ error: 'Access denied' });
}

router.get('/', requireAdmin, async (req, res) => {
  try {

    // ── Phase 0: Schema introspection FIRST ────────────────
    // Run schema before main queries so we can detect actual column names.
    const schemaResult = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'Assessment','AssessmentResult','AssessmentResultQuestionResponse',
          'AssessmentQuestion','AssessmentConstruct'
        )
      ORDER BY table_name, ordinal_position
    `);

    // Detect question text column name from live schema
    const aqCols = schemaResult.rows
      .filter(r => r.table_name === 'AssessmentQuestion')
      .map(r => r.column_name);
    const labelCol = ['label','text','title','question','prompt','content','name']
      .find(c => aqCols.includes(c)) || null;

    const [templateResult, pairingResult, arResult] = await Promise.all([

      // ── Template inventory ─────────────────────────────
      pool.query(`
        SELECT
          a."id",
          a."name",
          CASE
            WHEN a."name" ILIKE '%Legacy%' THEN 'Legacy'
            WHEN a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%' THEN 'EP'
            WHEN a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%' THEN 'RR'
            ELSE 'Other'
          END AS track_group,
          COUNT(ar."id")::int AS result_count,
          COUNT(CASE WHEN ar."type"::text = 'post' THEN 1 END)::int AS post_count,
          COUNT(CASE WHEN ar."type"::text = 'pre'  THEN 1 END)::int AS pre_count
        FROM "Assessment" a
        LEFT JOIN "AssessmentResult" ar ON ar."assessmentId" = a."id" AND ar."deleted_at" = 0
        WHERE (
          a."name" ILIKE 'Empowered Parenting%'
          OR a."name" ILIKE 'Crianza empoderada%'
          OR a."name" ILIKE 'Resilience%'
          OR a."name" ILIKE 'Hoja de ruta%'
          OR (a."name" ILIKE '%Empowered%' AND a."name" ILIKE '%Legacy%')
          OR (a."name" ILIKE '%Resilience%' AND a."name" ILIKE '%Legacy%')
        )
        GROUP BY a."id", a."name"
        ORDER BY track_group, a."name"
      `),

      // ── Completed EP/RR pairings in window ────────────
      pool.query(`
        SELECT DISTINCT ON (track_group, mom_id)
          p."id" AS pairing_id,
          p."momId" AS mom_id,
          p."created_at" AS pairing_start,
          p."completed_on",
          m."first_name",
          m."last_name",
          aff."name" AS affiliate_name,
          CASE
            WHEN t."title" ILIKE '%empowered%' OR t."title" ILIKE '%crianza empoderada%' THEN 'EP'
            WHEN t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%resilien%' OR t."title" ILIKE '%hoja de ruta%' THEN 'RR'
          END AS track_group
        FROM "Pairing" p
        LEFT JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId" AND ag."deleted_at" = 0
        JOIN "Track" t ON t."id" = COALESCE(p."trackId", ag."trackId")
        JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
        WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
          AND p."status"::text = 'pairing_complete'
          AND p."complete_reason_sub_status" IS NOT NULL
          AND p."completed_on" >= '${DATA_START}'
          AND p."completed_on" <= '${DATA_END} 23:59:59'
          AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
          AND (
            t."title" ILIKE '%empowered%' OR t."title" ILIKE '%crianza empoderada%'
            OR t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%resilien%' OR t."title" ILIKE '%hoja de ruta%'
          )
        ORDER BY track_group, mom_id, p."completed_on" DESC
      `),

      // ── All EP/RR assessment results in window ─────────
      pool.query(`
        SELECT
          ar."id" AS ar_id,
          ar."momId" AS mom_id,
          ar."type"::text AS atype,
          ar."completedAt" AS ar_date,
          CASE
            WHEN a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%' THEN 'EP'
            WHEN a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%' THEN 'RR'
          END AS track_group,
          a."name" AS template_name,
          COUNT(arqr."id")::int AS response_count,
          SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS answered_count,
          SUM(arqr."intResponse")::numeric AS sum_score,
          AVG(arqr."intResponse")::numeric AS avg_score
        FROM "AssessmentResult" ar
        JOIN "Assessment" a ON a."id" = ar."assessmentId"
        JOIN "Mom" m ON m."id" = ar."momId"
        LEFT JOIN "AssessmentResultQuestionResponse" arqr
          ON arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
        WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0
          AND ar."completedAt" IS NOT NULL
          AND a."name" NOT ILIKE '%Legacy%'
          AND (
            a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%'
            OR a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%'
          )
          AND ar."completedAt" >= '${DATA_START}'
          AND ar."completedAt" <= '${DATA_END} 23:59:59'
        GROUP BY ar."id", ar."momId", ar."type", ar."created_at", ar."completedAt", a."name"
        ORDER BY ar."momId", ar_date
      `),
    ]);

    // ── Question inventory (Phase 2 + Phase 4 pre-pool) ──
    const { rows: questionRows } = await pool.query(`
      SELECT
        a."name" AS template_name,
        CASE
          WHEN a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%' THEN 'EP'
          WHEN a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%' THEN 'RR'
        END AS track_group,
        CASE WHEN a."name" ILIKE '%post%' THEN 'post' ELSE 'pre' END AS template_type,
        aq."id"    AS question_id,
        aq."order" AS q_order,
        ${labelCol ? `aq."${labelCol}"` : 'NULL'} AS question_label,
        ac."id"    AS construct_id,
        ac."name"  AS construct_name,
        ac."order" AS construct_order,
        COUNT(DISTINCT arqr."assessmentResultId")::int AS response_count,
        MIN(arqr."intResponse")::int AS obs_min,
        MAX(arqr."intResponse")::int AS obs_max,
        AVG(arqr."intResponse")::numeric AS obs_mean,
        STDDEV(arqr."intResponse")::numeric AS obs_stddev,
        SUM(CASE WHEN arqr."intResponse" = 5 THEN 1 ELSE 0 END)::int AS at_ceiling,
        SUM(CASE WHEN arqr."intResponse" = 1 THEN 1 ELSE 0 END)::int AS at_floor,
        SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS answered,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY arqr."intResponse") AS obs_median,
        SUM(CASE WHEN arqr."intResponse" = 1 THEN 1 ELSE 0 END)::int AS resp_1,
        SUM(CASE WHEN arqr."intResponse" = 2 THEN 1 ELSE 0 END)::int AS resp_2,
        SUM(CASE WHEN arqr."intResponse" = 3 THEN 1 ELSE 0 END)::int AS resp_3,
        SUM(CASE WHEN arqr."intResponse" = 4 THEN 1 ELSE 0 END)::int AS resp_4,
        SUM(CASE WHEN arqr."intResponse" = 5 THEN 1 ELSE 0 END)::int AS resp_5
      FROM "Assessment" a
      JOIN "AssessmentQuestion" aq ON aq."assessmentId" = a."id" AND aq."deleted_at" = 0
      LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
      LEFT JOIN "AssessmentResultQuestionResponse" arqr
        ON arqr."assessmentQuestionId" = aq."id" AND arqr."deleted_at" = 0
      LEFT JOIN "AssessmentResult" ar
        ON ar."id" = arqr."assessmentResultId" AND ar."deleted_at" = 0
      WHERE a."name" NOT ILIKE '%Legacy%'
        AND (
          a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%'
          OR a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%'
        )
      GROUP BY a."name", aq."id", aq."order", ${labelCol ? `aq."${labelCol}"` : 'aq."id"'}, ac."id", ac."name", ac."order"
      ORDER BY track_group, template_type, COALESCE(ac."order", 999), aq."order"
    `);

    // ── Match pairings to pre/post assessment results ────
    const arRows     = arResult.rows;
    const pairingRows = pairingResult.rows;

    const arByMom = {};
    for (const r of arRows) {
      if (!arByMom[r.mom_id]) arByMom[r.mom_id] = [];
      arByMom[r.mom_id].push(r);
    }

    const pairedData = pairingRows.map(p => {
      const momArs = (arByMom[p.mom_id] || []).filter(ar => ar.track_group === p.track_group);
      const posts = momArs.filter(ar => ar.atype === 'post' && ar.ar_date >= p.pairing_start)
                          .sort((a, b) => b.ar_date < a.ar_date ? -1 : 1);
      const post = posts[0] || null;
      const pre  = post
        ? momArs.filter(ar => ar.atype === 'pre' && ar.ar_date < post.ar_date)
                .sort((a, b) => b.ar_date < a.ar_date ? -1 : 1)[0] || null
        : null;
      return { ...p, post, pre, has_post: !!post, has_pre: !!pre, has_pair: !!(post && pre) };
    });

    const pairedWithBoth = pairedData.filter(d => d.has_pair);

    // ── Domain aggregation for Method A ─────────────────
    const pairedArIds = pairedWithBoth.flatMap(d => [d.pre.ar_id, d.post.ar_id]);
    let domainByAr = {};

    if (pairedArIds.length > 0) {
      const ph = pairedArIds.map((_, i) => `$${i+1}`).join(',');

      // Cross-template text matching: build a canonical question-text → construct map
      // from any question that has assessmentConstructId set, then apply it to all
      // responses by label match — this recovers domain data for templates where the
      // construct linkage was never configured in Trellis but the question text is identical.
      const textJoin = labelCol
        ? `LEFT JOIN q_construct_map qcm ON qcm.q_text = aq."${labelCol}"`
        : '';
      const textCte = labelCol ? `
        WITH q_construct_map AS (
          SELECT DISTINCT ON (aq."${labelCol}")
            aq."${labelCol}" AS q_text,
            ac."name"  AS construct_name,
            ac."order" AS construct_order
          FROM "AssessmentQuestion" aq
          JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
          WHERE aq."deleted_at" = 0 AND aq."${labelCol}" IS NOT NULL
          ORDER BY aq."${labelCol}", ac."order"
        )` : '';

      const { rows: dr } = await pool.query(`
        ${textCte}
        SELECT
          arqr."assessmentResultId" AS ar_id,
          COALESCE(ac."name", ${labelCol ? 'qcm.construct_name,' : ''} 'No Domain') AS construct_name,
          COALESCE(ac."order", ${labelCol ? 'qcm.construct_order,' : ''} 999)        AS construct_order,
          AVG(arqr."intResponse")::numeric  AS domain_mean,
          COUNT(*)::int                     AS q_count
        FROM "AssessmentResultQuestionResponse" arqr
        JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId" AND aq."deleted_at" = 0
        LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
        ${textJoin}
        WHERE arqr."assessmentResultId" IN (${ph})
          AND arqr."deleted_at" = 0
          AND arqr."intResponse" IS NOT NULL
        GROUP BY arqr."assessmentResultId",
          COALESCE(ac."name", ${labelCol ? 'qcm.construct_name,' : ''} 'No Domain'),
          COALESCE(ac."order", ${labelCol ? 'qcm.construct_order,' : ''} 999)
        ORDER BY arqr."assessmentResultId",
          COALESCE(ac."order", ${labelCol ? 'qcm.construct_order,' : ''} 999)
      `, pairedArIds);
      for (const d of dr) {
        if (!domainByAr[d.ar_id]) domainByAr[d.ar_id] = [];
        domainByAr[d.ar_id].push(d);
      }
    }

    // ── Per-question pre/post for anyDomain (RR) — must run before momResults ──
    const anyQImprovedByMom = {};
    const rawQRows = [];
    if (pairedArIds.length > 0) {
      const phq = pairedArIds.map((_, i) => `$${i+1}`).join(',');
      const { rows: qrEarly } = await pool.query(`
        SELECT arqr."assessmentResultId" AS ar_id,
               arqr."assessmentQuestionId" AS q_id,
               arqr."intResponse"
        FROM "AssessmentResultQuestionResponse" arqr
        WHERE arqr."assessmentResultId" IN (${phq})
          AND arqr."deleted_at" = 0
          AND arqr."intResponse" IS NOT NULL
      `, pairedArIds);
      rawQRows.push(...qrEarly);

      const arSideEarly = {};
      for (const d of pairedWithBoth) {
        arSideEarly[d.pre.ar_id]  = { side: 'pre',  mom: d.mom_id };
        arSideEarly[d.post.ar_id] = { side: 'post', mom: d.mom_id };
      }
      const byMomQEarly = {};
      for (const r of qrEarly) {
        const info = arSideEarly[r.ar_id];
        if (!info) continue;
        const key = `${info.mom}|${r.q_id}`;
        if (!byMomQEarly[key]) byMomQEarly[key] = { pre: null, post: null, mom: info.mom };
        byMomQEarly[key][info.side] = r.intResponse;
      }
      for (const entry of Object.values(byMomQEarly)) {
        if (entry.pre == null || entry.post == null) continue;
        if (anyQImprovedByMom[entry.mom] === undefined) anyQImprovedByMom[entry.mom] = false;
        if (entry.post > entry.pre) anyQImprovedByMom[entry.mom] = true;
      }
    }

    // ── Compute three methods per paired mom ─────────────
    function score(arId, sumScoreRaw) {
      const domains = domainByAr[arId] || [];
      // For EP: mean of named domain means. For RR: single 'No Domain' entry = flat average.
      // Either way, if domains exist, average their means.
      const scorableDomains = domains.filter(d => d.q_count > 0);
      const methodA = scorableDomains.length > 0
        ? scorableDomains.reduce((s, d) => s + parseFloat(d.domain_mean), 0) / scorableDomains.length
        : null;
      return {
        C: parseFloat(sumScoreRaw) || 0,   // flat sum — current KPI 3
        A: pf(methodA),                    // mean of domain means (or flat avg for RR)
      };
    }

    const momResults = pairedWithBoth.map(d => {
      const pre  = score(d.pre.ar_id,  d.pre.sum_score);
      const post = score(d.post.ar_id, d.post.sum_score);
      const iC = d.pre.answered_count > 0 && d.post.answered_count > 0 ? post.C > pre.C : null;
      const iA = pre.A != null && post.A != null ? post.A > pre.A : null;

      // Any-domain: for tracks with real domain structure (EP), compare domain means.
      // For tracks with no domains (RR), treat each question as its own domain —
      // mom counts as improved if any single question score went up.
      const preDomains = domainByAr[d.pre.ar_id] || [];
      const postDomains = domainByAr[d.post.ar_id] || [];
      const hasRealDomains = postDomains.some(pd => pd.construct_name !== 'No Domain');
      const preDomainMap = {};
      preDomains.forEach(pd => { preDomainMap[pd.construct_name] = parseFloat(pd.domain_mean); });
      const domainResults = postDomains
        .filter(pd => pd.construct_name !== 'No Domain')
        .map(pd => ({
          name: pd.construct_name,
          pre_mean: preDomainMap[pd.construct_name] ?? null,
          post_mean: parseFloat(pd.domain_mean),
          improved: preDomainMap[pd.construct_name] != null
            ? parseFloat(pd.domain_mean) > preDomainMap[pd.construct_name]
            : null,
        }));
      let anyDomainImproved;
      if (hasRealDomains) {
        anyDomainImproved = domainResults.some(dr => dr.improved === true) ? true
          : domainResults.every(dr => dr.improved === null) ? null : false;
      } else {
        // No domain structure — use per-question comparison
        const qData = anyQImprovedByMom[d.mom_id];
        anyDomainImproved = qData === undefined ? null : qData;
      }

      return {
        mom_id: d.mom_id, first_name: d.first_name, last_name: d.last_name,
        track_group: d.track_group, affiliate: d.affiliate_name,
        pre_answered: d.pre.answered_count, post_answered: d.post.answered_count,
        pre_C: pre.C,  post_C: post.C,  improved_C: iC,
        pre_A: pre.A,  post_A: post.A,  improved_A: iA,
        improved_anyDomain: anyDomainImproved,
        domain_results: domainResults,
        flip_AvsC: iA != null && iA !== iC,
      };
    });

    // ── Item movement (paired cohort per question) ───────
    // Reuses rawQRows fetched above — no second DB query needed.
    let itemMovement = {};
    if (rawQRows.length > 0) {
      const arSide = {};
      for (const d of pairedWithBoth) {
        arSide[d.pre.ar_id]  = { side: 'pre',  mom: d.mom_id };
        arSide[d.post.ar_id] = { side: 'post', mom: d.mom_id };
      }
      const byMomQ = {};
      for (const r of rawQRows) {
        const info = arSide[r.ar_id];
        if (!info) continue;
        const key = `${info.mom}|${r.q_id}`;
        if (!byMomQ[key]) byMomQ[key] = { q_id: r.q_id };
        byMomQ[key][info.side] = r.intResponse;
      }
      for (const entry of Object.values(byMomQ)) {
        if (entry.pre == null || entry.post == null) continue;
        const q = entry.q_id;
        if (!itemMovement[q]) itemMovement[q] = { n: 0, increased: 0, same: 0, decreased: 0, pre_sum: 0, post_sum: 0 };
        itemMovement[q].n++;
        itemMovement[q].pre_sum  += entry.pre;
        itemMovement[q].post_sum += entry.post;
        if (entry.post > entry.pre)      itemMovement[q].increased++;
        else if (entry.post < entry.pre) itemMovement[q].decreased++;
        else                             itemMovement[q].same++;
      }
    }

    // ── Teisha Shepherd validation ───────────────────────
    const { rows: teishaRows } = await pool.query(`
      SELECT ar."id" AS ar_id, m."first_name", m."last_name",
        ar."type"::text AS atype,
        COALESCE(ar."completedAt", ar."created_at") AS ar_date,
        COUNT(arqr."id")::int AS q_count,
        SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS answered,
        SUM(arqr."intResponse")::numeric AS sum_score,
        AVG(arqr."intResponse")::numeric AS avg_score
      FROM "AssessmentResult" ar
      JOIN "Assessment" a ON a."id" = ar."assessmentId"
      JOIN "Mom" m ON m."id" = ar."momId"
      LEFT JOIN "AssessmentResultQuestionResponse" arqr
        ON arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
      WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0
        AND a."name" NOT ILIKE '%Legacy%'
        AND (a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%')
        AND (m."first_name" ILIKE '%Teisha%' OR m."last_name" ILIKE '%Shepherd%')
      GROUP BY ar."id", m."first_name", m."last_name", ar."type", ar."created_at", ar."completedAt"
      ORDER BY ar_date DESC
    `);

    let teishaDomains = [];
    const teishaPre = teishaRows.find(r => r.atype === 'pre');
    if (teishaPre) {
      const { rows: td } = await pool.query(`
        SELECT COALESCE(ac."name", 'No Domain') AS construct_name,
               COALESCE(ac."order", 999) AS construct_order,
               AVG(arqr."intResponse")::numeric AS domain_mean,
               COUNT(*)::int AS q_count
        FROM "AssessmentResultQuestionResponse" arqr
        JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId" AND aq."deleted_at" = 0
        LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
        WHERE arqr."assessmentResultId" = $1 AND arqr."deleted_at" = 0
          AND arqr."intResponse" IS NOT NULL
        GROUP BY ac."id", ac."name", ac."order"
        ORDER BY COALESCE(ac."order", 999)
      `, [teishaPre.ar_id]);
      teishaDomains = td;
    }

    // ── Build affiliate funnel summary ───────────────────
    const affiliateFunnel = {};
    for (const d of pairedData) {
      const aff = d.affiliate_name || 'Unknown';
      if (!affiliateFunnel[aff]) affiliateFunnel[aff] = { completions: 0, has_pre: 0, has_post: 0, has_pair: 0 };
      affiliateFunnel[aff].completions++;
      if (d.has_pre)  affiliateFunnel[aff].has_pre++;
      if (d.has_post) affiliateFunnel[aff].has_post++;
      if (d.has_pair) affiliateFunnel[aff].has_pair++;
    }

    // ── KPI rates per method ──────────────────────────────
    function kpiRate(moms, method) {
      const key = `improved_${method}`;
      const eligible = moms.filter(m => m[key] != null);
      return { num: eligible.filter(m => m[key]).length, den: eligible.length };
    }
    const epMoms = momResults.filter(m => m.track_group === 'EP');
    const rrMoms = momResults.filter(m => m.track_group === 'RR');

    res.json({
      meta: { data_start: DATA_START, data_end: DATA_END, generated: new Date().toISOString(), label_col: labelCol },
      schema:    schemaResult.rows,
      templates: templateResult.rows,
      pairedData: pairedData.map(d => ({
        ...d,
        pre:  d.pre  ? { ar_id: d.pre.ar_id,  ar_date: d.pre.ar_date,  sum_score: d.pre.sum_score,  avg_score: d.pre.avg_score,  answered_count: d.pre.answered_count  } : null,
        post: d.post ? { ar_id: d.post.ar_id, ar_date: d.post.ar_date, sum_score: d.post.sum_score, avg_score: d.post.avg_score, answered_count: d.post.answered_count } : null,
      })),
      questions:      questionRows,
      momResults,
      itemMovement,
      teishaRows,
      teishaDomains,
      affiliateFunnel,
      rates: {
        ep: { C: kpiRate(epMoms,'C'), A: kpiRate(epMoms,'A'), anyDomain: kpiRate(epMoms,'anyDomain') },
        rr: { C: kpiRate(rrMoms,'C'), A: kpiRate(rrMoms,'A'), anyDomain: kpiRate(rrMoms,'anyDomain') },
      },
      counts: {
        total_completions: pairedData.length,
        with_post:  pairedData.filter(d => d.has_post).length,
        with_pair:  pairedWithBoth.length,
        ep_pair:    pairedWithBoth.filter(d => d.track_group === 'EP').length,
        rr_pair:    pairedWithBoth.filter(d => d.track_group === 'RR').length,
        pre_only_orphans:  Object.values(arByMom).filter(ars => ars.some(a=>a.atype==='pre') && !ars.some(a=>a.atype==='post')).length,
        post_only_orphans: Object.values(arByMom).filter(ars => !ars.some(a=>a.atype==='pre') && ars.some(a=>a.atype==='post')).length,
        legacy_count: templateResult.rows.filter(r=>r.track_group==='Legacy').reduce((s,r)=>s+r.result_count,0),
        flips_AvsC: momResults.filter(m => m.flip_AvsC).length,
      },
    });

  } catch (err) {
    console.error('[ep-rr-diagnostic] error:', err);
    res.status(500).json({ error: err.message, detail: err.detail || null, hint: err.hint || null });
  }
});

module.exports = router;
