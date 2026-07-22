require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const pool = require('./db');
const { login, logout, me, requireAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ema-tickets-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', requireAuth, me);

// API routes
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/schemas', require('./routes/schemas'));
app.use('/api/team', require('./routes/team'));
app.use('/api/upload', require('./routes/attachments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/timelogs', require('./routes/timelogs'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/report-data', requireAuth, requireRole, require('./routes/report-data'));
app.use('/api/advocates', require('./routes/advocates'));
app.use('/api/mom-status', require('./routes/mom-status'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin/champions', requireAuth, require('./routes/champions'));
app.use('/api/admin/export', require('./routes/admin-export'));
app.use('/api/champion', require('./routes/champion-auth'));
app.use('/api/track-journey', require('./routes/track-journey'));
app.use('/api/court-summary', require('./routes/court-summary'));
app.use('/api/child-welfare', require('./routes/child-welfare'));
app.use('/api/flagged-needs', require('./routes/flagged-needs'));
app.use('/api/kpi1-breakdown', require('./routes/kpi1-breakdown'));
app.use('/api/kpi2-trial', requireAuth, require('./routes/kpi2-trial'));
app.use('/api/ep-rr-diagnostic', requireAuth, require('./routes/ep-rr-diagnostic'));
app.use('/api/kpi2-diagnostic', requireAuth, require('./routes/kpi2-diagnostic'));
app.use('/api/sla-timing', require('./routes/sla-timing'));

// Generic HIPAA export audit endpoint — shared by advocate-care.html and mom-status-report.html.
// Both pages POST { timestamp, recordCount, recordIds, filters } here on CSV export.
// Logged to Railway console for compliance; kept intentionally lightweight (no DB write yet).
app.post('/api/export-audit', requireAuth, express.json(), (req, res) => {
  try {
    const user = req.session.user;
    const { timestamp, recordCount, recordIds, filters } = req.body || {};
    const source = req.get('referer') || 'unknown';
    console.log(`[EXPORT-AUDIT] ${user.username} (${user.role}) exported ${recordCount || 0} records at ${timestamp || new Date().toISOString()} from ${source}`);
    console.log(`[EXPORT-AUDIT] Filters: ${JSON.stringify(filters || {})}`);
    console.log(`[EXPORT-AUDIT] Record IDs: ${JSON.stringify(recordIds || [])}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Export audit error:', err);
    res.status(500).json({ error: 'Audit log failed' });
  }
});

// EP/RR domain linkage probe — administrator only, temporary
// Diagnoses why some paired moms are missing from domain-weighted scoring
app.get('/api/admin/domain-linkage-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    const DATA_START = '2025-12-01';
    const DATA_END   = '2026-07-31';

    // Step 1: get all paired ar_ids (same logic as diagnostic route)
    const { rows: arRows } = await pool.query(`
      SELECT ar."id" AS ar_id, ar."momId" AS mom_id, ar."type"::text AS atype,
             a."name" AS template_name,
             COUNT(arqr."id")::int AS response_count,
             SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS answered_count
      FROM "AssessmentResult" ar
      JOIN "Assessment" a ON a."id" = ar."assessmentId"
      JOIN "Mom" m ON m."id" = ar."momId"
      LEFT JOIN "AssessmentResultQuestionResponse" arqr ON arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
      WHERE ar."deleted_at" = 0 AND m."deleted_at" = 0
        AND a."name" NOT ILIKE '%Legacy%'
        AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Resilience%'
          OR a."name" ILIKE 'Crianza empoderada%' OR a."name" ILIKE 'Hoja de ruta%')
        AND COALESCE(ar."completedAt", ar."created_at") >= '${DATA_START}'
        AND COALESCE(ar."completedAt", ar."created_at") <= '${DATA_END} 23:59:59'
      GROUP BY ar."id", ar."momId", ar."type", a."name"
    `);

    // Step 2: for each ar_id, check if any of its questions have a construct assigned
    const arIds = arRows.map(r => r.ar_id);
    let domainCoverage = {};
    if (arIds.length > 0) {
      const ph = arIds.map((_, i) => `$${i+1}`).join(',');
      const { rows: dcRows } = await pool.query(`
        SELECT arqr."assessmentResultId" AS ar_id,
               COUNT(aq."id")::int AS total_questions,
               COUNT(aq."assessmentConstructId")::int AS questions_with_construct,
               COUNT(DISTINCT ac."name") AS distinct_constructs
        FROM "AssessmentResultQuestionResponse" arqr
        JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId" AND aq."deleted_at" = 0
        LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
        WHERE arqr."assessmentResultId" IN (${ph})
          AND arqr."deleted_at" = 0
          AND arqr."intResponse" IS NOT NULL
        GROUP BY arqr."assessmentResultId"
      `, arIds);
      dcRows.forEach(r => { domainCoverage[r.ar_id] = r; });
    }

    // Step 3: check what constructs exist on the assessment templates themselves
    const { rows: templateConstructs } = await pool.query(`
      SELECT a."name" AS template_name,
             COUNT(aq."id")::int AS total_questions,
             COUNT(aq."assessmentConstructId")::int AS questions_with_construct,
             COUNT(DISTINCT ac."name") AS distinct_constructs,
             array_agg(DISTINCT ac."name") FILTER (WHERE ac."name" IS NOT NULL) AS construct_names
      FROM "Assessment" a
      JOIN "AssessmentQuestion" aq ON aq."assessmentId" = a."id" AND aq."deleted_at" = 0
      LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
      WHERE a."name" NOT ILIKE '%Legacy%'
        AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Resilience%'
          OR a."name" ILIKE 'Crianza empoderada%' OR a."name" ILIKE 'Hoja de ruta%')
        AND aq."deleted_at" = 0
      GROUP BY a."id", a."name"
      ORDER BY a."name"
    `);

    const report = arRows.map(r => ({
      ar_id: r.ar_id,
      mom_id: r.mom_id,
      template: r.template_name,
      type: r.atype,
      response_count: r.response_count,
      answered_count: r.answered_count,
      has_responses: r.answered_count > 0,
      domain_coverage: domainCoverage[r.ar_id] || null,
      has_domain_data: !!domainCoverage[r.ar_id],
      questions_with_construct: domainCoverage[r.ar_id]?.questions_with_construct || 0,
    }));

    const noResponses   = report.filter(r => !r.has_responses).length;
    const noConstructs  = report.filter(r => r.has_responses && !r.has_domain_data).length;
    const hasConstructs = report.filter(r => r.has_domain_data).length;

    res.json({
      summary: { total_ar: report.length, no_responses: noResponses, has_responses_no_constructs: noConstructs, has_domain_data: hasConstructs },
      template_construct_coverage: templateConstructs,
      assessment_results: report,
    });
  } catch (err) {
    console.error('domain-linkage-probe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// RR post-assessment gap probe — checks why RR moms have 0 post responses
app.get('/api/admin/rr-post-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    // Step 1: get the RR paired moms from the same window as the diagnostic
    const { rows: rrMoms } = await pool.query(`
      SELECT DISTINCT ON (p."momId")
        p."id" AS pairing_id, p."momId" AS mom_id,
        p."created_at" AS pairing_start, p."completed_on",
        m."first_name", m."last_name", aff."name" AS affiliate
      FROM "Pairing" p
      JOIN "Track" t ON t."id" = p."trackId"
      JOIN "Mom" m ON m."id" = p."momId"
      LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
      WHERE p."deleted_at" = 0 AND m."deleted_at" = 0
        AND p."status"::text = 'pairing_complete'
        AND p."completed_on" >= '2026-01-01'
        AND p."completed_on" <= '2026-06-30 23:59:59'
        AND DATE_TRUNC('day', p."created_at") != DATE_TRUNC('day', p."completed_on")
        AND (t."title" ILIKE '%roadmap%' OR t."title" ILIKE '%resilien%' OR t."title" ILIKE '%hoja de ruta%')
      ORDER BY p."momId", p."completed_on" DESC
    `);

    const momIds = rrMoms.map(r => r.mom_id);
    if (!momIds.length) return res.json({ rr_moms: [], all_assessments: [] });

    const ph = momIds.map((_, i) => `$${i+1}`).join(',');

    // Step 2: ALL assessment results for these moms — any template, any type, any date
    const { rows: allAr } = await pool.query(`
      SELECT
        ar."id" AS ar_id, ar."momId" AS mom_id,
        ar."type"::text AS atype,
        a."name" AS template_name,
        COALESCE(ar."completedAt", ar."created_at") AS ar_date,
        ar."deleted_at",
        COUNT(arqr."id")::int AS response_count,
        SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS answered_count
      FROM "AssessmentResult" ar
      JOIN "Assessment" a ON a."id" = ar."assessmentId"
      LEFT JOIN "AssessmentResultQuestionResponse" arqr
        ON arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
      WHERE ar."momId" IN (${ph})
      GROUP BY ar."id", ar."momId", ar."type", a."name", ar."completedAt", ar."created_at", ar."deleted_at"
      ORDER BY ar."momId", ar_date DESC
    `, momIds);

    // Step 3: check what distinct assessment types and template names appear for 'post' results
    const { rows: postSummary } = await pool.query(`
      SELECT
        a."name" AS template_name,
        ar."type"::text AS atype,
        COUNT(ar."id")::int AS result_count,
        SUM(CASE WHEN arqr."intResponse" IS NOT NULL THEN 1 ELSE 0 END)::int AS total_answered,
        COUNT(DISTINCT ar."momId")::int AS distinct_moms
      FROM "AssessmentResult" ar
      JOIN "Assessment" a ON a."id" = ar."assessmentId"
      LEFT JOIN "AssessmentResultQuestionResponse" arqr
        ON arqr."assessmentResultId" = ar."id" AND arqr."deleted_at" = 0
      WHERE ar."momId" IN (${ph}) AND ar."deleted_at" = 0
      GROUP BY a."name", ar."type"
      ORDER BY a."name", ar."type"
    `, momIds);

    res.json({
      rr_mom_count: rrMoms.length,
      rr_moms: rrMoms,
      template_type_summary: postSummary,
      all_assessments: allAr,
    });
  } catch (err) {
    console.error('rr-post-probe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// BenevolenceNeed column probe — administrator only, temporary
app.get('/api/admin/benevolence-need-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    const [msgPerm, noNotes, sampleNotes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS has_msg_perm FROM "BenevolenceNeed" WHERE "deleted_at" = 0 AND "created_at" >= '2026-01-01' AND "notes_c" ILIKE '%msg_permissions%'`),
      pool.query(`SELECT COUNT(*)::int AS null_notes FROM "BenevolenceNeed" WHERE "deleted_at" = 0 AND "created_at" >= '2026-01-01' AND ("notes_c" IS NULL OR "notes_c" = '')`),
      pool.query(`SELECT LEFT("notes_c", 300) AS notes_snippet FROM "BenevolenceNeed" WHERE "deleted_at" = 0 AND "created_at" >= '2026-01-01' AND "notes_c" IS NOT NULL AND "notes_c" != '' LIMIT 5`),
    ]);
    res.json({ has_msg_perm: msgPerm.rows[0], null_notes: noNotes.rows[0], sample_notes: sampleNotes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AuditLog shape diagnostic — administrator only, read-only, temporary
app.get('/api/admin/audit-log-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    const [keys, advocateSample, q1Count, rawSample] = await Promise.all([
      // Which keys appear in data for User Update rows, and how often?
      pool.query(`
        SELECT jsonb_object_keys(data) AS key, COUNT(*)::int AS n
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
        GROUP BY key ORDER BY n DESC LIMIT 40
      `),
      // Any rows where data contains an advocate_status-like key?
      pool.query(`
        SELECT created_at, data
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
          AND (data ? 'advocate_status' OR data ? 'advocateStatus'
            OR data ? 'advocate_sub_status' OR data ? 'advocateSubStatus')
        ORDER BY created_at DESC LIMIT 10
      `),
      // How many User Update rows fall in Q1?
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
          AND created_at >= '2026-01-01' AND created_at <= '2026-03-31 23:59:59'
      `),
      // 5 raw rows — check the actual data shape
      pool.query(`
        SELECT created_at, action, data
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
        ORDER BY created_at DESC LIMIT 5
      `),
    ]);
    res.json({
      keys: keys.rows,
      advocate_sample: advocateSample.rows,
      q1_user_update_count: q1Count.rows[0]?.count,
      raw_sample: rawSample.rows,
    });
  } catch (err) {
    console.error('audit-log-probe error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/admin/wa-schema-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    // For each text-type question column: distinct values + counts (from all non-deleted WAs)
    // Pick a representative sample across domains
    const sampleCols = [
      'cc_affordability','cc_reliable_care','cc_health_ins',
      'naa_discipline','naa_emotions','naa_child_behavior',
      'res_happiness','res_fulfillment','res_overall_sat',
      'soc_resolve_arguments','soc_status','soc_dynamics',
      'home_category','home_safe','home_type',
      'trnprt_access','trnprt_affordable','trnprt_license',
      'well_mental_health','well_phq_q1','well_gad_q1',
      'edu_high_school','edu_training',
      'ei_emp_status','ei_inc_subsidy',
      'fin_budget','fin_savings',
      'ats_difficulty','ats_afford_food',
    ];
    const distinctQueries = sampleCols.map(col =>
      pool.query(`
        SELECT '${col}' AS col, "${col}"::text AS val, COUNT(*)::int AS n
        FROM "WellnessAssessment"
        WHERE deleted_at = 0 AND "${col}" IS NOT NULL
        GROUP BY "${col}"
        ORDER BY n DESC
        LIMIT 10
      `).catch(e => ({ rows: [{ col, val: 'ERROR: ' + e.message, n: 0 }] }))
    );

    // For the paired cohort (matching diagnostic logic): how often do question values
    // NOT change between intake and 6-month FWA?
    const freezeProbe = pool.query(`
      WITH intake_dates AS (
        SELECT al.data->>'id' AS mom_id, MIN(al.created_at) AS coordinator_engaged_date
        FROM "AuditLog" al
        WHERE al."table" = 'Mom' AND al.action = 'Update'
          AND al.data->>'prospect_status' = 'engaged_in_program'
          AND DATE_TRUNC('day', al.created_at) NOT IN ('2025-11-30'::date,'2025-12-17'::date)
        GROUP BY al.data->>'id'
      ),
      pre_fwa AS (
        SELECT DISTINCT ON (w.mom_id)
          w.mom_id, w.id AS pre_id,
          w.naa_discipline, w.naa_emotions, w.naa_child_behavior,
          w.res_happiness, w.res_fulfillment, w.res_overall_sat,
          w.soc_status, w.soc_resolve_arguments,
          w.home_category, w.home_safe,
          w.trnprt_access, w.trnprt_affordable,
          w.well_mental_health, w.ei_emp_status, w.fin_budget, w.fin_savings,
          w.ats_difficulty
        FROM "WellnessAssessment" w
        JOIN intake_dates id ON id.mom_id = w.mom_id
        WHERE w.cpi_total IS NOT NULL AND w.deleted_at = 0
        ORDER BY w.mom_id, w.created_at ASC
      ),
      post_fwa AS (
        SELECT DISTINCT ON (w.mom_id)
          w.mom_id, w.id AS post_id,
          w.naa_discipline, w.naa_emotions, w.naa_child_behavior,
          w.res_happiness, w.res_fulfillment, w.res_overall_sat,
          w.soc_status, w.soc_resolve_arguments,
          w.home_category, w.home_safe,
          w.trnprt_access, w.trnprt_affordable,
          w.well_mental_health, w.ei_emp_status, w.fin_budget, w.fin_savings,
          w.ats_difficulty
        FROM "WellnessAssessment" w
        JOIN intake_dates id ON id.mom_id = w.mom_id
        WHERE w.cpi_total IS NOT NULL AND w.deleted_at = 0
          AND w.updated_at >= id.coordinator_engaged_date + INTERVAL '91 days'
          AND w.updated_at <= id.coordinator_engaged_date + INTERVAL '180 days'
        ORDER BY w.mom_id, w.updated_at DESC
      )
      SELECT
        COUNT(*) AS paired_n,
        -- per question: how many moms have identical pre vs post value
        SUM((pre.naa_discipline IS NOT DISTINCT FROM post.naa_discipline)::int) AS naa_discipline_same,
        SUM((pre.naa_emotions   IS NOT DISTINCT FROM post.naa_emotions)::int)   AS naa_emotions_same,
        SUM((pre.naa_child_behavior IS NOT DISTINCT FROM post.naa_child_behavior)::int) AS naa_child_behavior_same,
        SUM((pre.res_happiness  IS NOT DISTINCT FROM post.res_happiness)::int)  AS res_happiness_same,
        SUM((pre.res_fulfillment IS NOT DISTINCT FROM post.res_fulfillment)::int) AS res_fulfillment_same,
        SUM((pre.res_overall_sat IS NOT DISTINCT FROM post.res_overall_sat)::int) AS res_overall_sat_same,
        SUM((pre.soc_status     IS NOT DISTINCT FROM post.soc_status)::int)     AS soc_status_same,
        SUM((pre.soc_resolve_arguments IS NOT DISTINCT FROM post.soc_resolve_arguments)::int) AS soc_resolve_arguments_same,
        SUM((pre.home_category  IS NOT DISTINCT FROM post.home_category)::int)  AS home_category_same,
        SUM((pre.trnprt_access  IS NOT DISTINCT FROM post.trnprt_access)::int)  AS trnprt_access_same,
        SUM((pre.trnprt_affordable IS NOT DISTINCT FROM post.trnprt_affordable)::int) AS trnprt_affordable_same,
        SUM((pre.well_mental_health IS NOT DISTINCT FROM post.well_mental_health)::int) AS well_mental_health_same,
        SUM((pre.ei_emp_status  IS NOT DISTINCT FROM post.ei_emp_status)::int)  AS ei_emp_status_same,
        SUM((pre.fin_budget     IS NOT DISTINCT FROM post.fin_budget)::int)     AS fin_budget_same,
        SUM((pre.fin_savings    IS NOT DISTINCT FROM post.fin_savings)::int)    AS fin_savings_same,
        SUM((pre.ats_difficulty IS NOT DISTINCT FROM post.ats_difficulty)::int) AS ats_difficulty_same
      FROM pre_fwa pre
      JOIN post_fwa post ON post.mom_id = pre.mom_id
    `).catch(e => ({ rows: [{ error: e.message }] }));

    // View definition
    const viewDef = pool.query(`
      SELECT definition FROM pg_views WHERE viewname = 'v_wellness_assessment_cpi_history'
    `).catch(() => ({ rows: [] }));

    const [distinctResults, freeze, view] = await Promise.all([
      Promise.all(distinctQueries), freezeProbe, viewDef
    ]);

    const distinctValues = {};
    for (const r of distinctResults) {
      if (r.rows.length) {
        const col = r.rows[0].col;
        distinctValues[col] = r.rows.map(x => ({ val: x.val, n: x.n }));
      }
    }

    res.json({
      question_distinct_values: distinctValues,
      freeze_probe: freeze.rows[0] || {},
      view_definition: view.rows[0]?.definition || null,
    });
  } catch (err) {
    console.error('wa-schema-probe error:', err);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

app.get('/api/affiliates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT "id", "name" FROM "Affiliate" WHERE "deleted_at" = 0 AND "status" = 'Active' ORDER BY "name"`
    );
    res.json(rows);
  } catch (err) {
    console.error('Affiliates lookup error:', err);
    res.status(500).json({ error: 'Failed to load affiliates' });
  }
});

// Advocate lookup — queries shared User table (same DB as Reset Tool)
app.get('/api/advocate-lookup/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT "id", "firstName", "lastName" FROM "User" WHERE "id" = $1 AND "deleted_at" = 0 LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Advocate not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Advocate lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'hub.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/champions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-champions.html')));
app.get('/set-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'set-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/report/quarterly/q1-2026', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/report/quarterly/q2-2026', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/report/advocate-care', (req, res) => res.sendFile(path.join(__dirname, 'public', 'advocate-care.html')));
app.get('/report/mom-status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mom-status-report.html')));
app.get('/report/users', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-report.html')));
app.get('/integrity', (req, res) => res.sendFile(path.join(__dirname, 'public', 'integrity.html')));
app.get('/track-journey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'track-journey.html')));
app.get('/court-summary', (req, res) => res.sendFile(path.join(__dirname, 'public', 'court-summary.html')));
app.get('/report/child-welfare-status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'child-welfare-status-report.html')));
app.get('/report/flagged-needs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flagged-needs.html')));
app.get('/report/kpi1-preservation-breakdown', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kpi1-preservation-breakdown.html')));
app.get('/report/kpi2-trial', requireAuth, (req, res) => {
  if ((req.session.user.username || '').toLowerCase() !== 'cristina.galloway') {
    return res.status(403).send('Access denied');
  }
  res.sendFile(path.join(__dirname, 'public', 'kpi2-trial.html'));
});
app.get('/report/ep-rr-diagnostic', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ep-rr-diagnostic.html'));
});
app.get('/report/sla-timing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sla-timing.html')));
app.get('/report/kpi2-diagnostic', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kpi2-diagnostic.html'));
});

// Startup migrations — idempotent ALTER TABLE statements for new columns
pool.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "availability" text`)
  .then(() => console.log('[startup] User.availability column ready'))
  .catch(err => console.error('[startup] User.availability migration error:', err.message));

app.listen(PORT, () => {
  console.log(`ĒMA KPI Dashboard running on port ${PORT}`);
});
