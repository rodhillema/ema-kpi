'use strict';
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const ORG_WIDE_ROLES = ['administrator'];
const ORG_WIDE_NAMES = ['rd.hill', 'cristina.galloway'];

// GET /api/court-summary/pairings — affiliate-scoped selector list
// Identical logic to track-journey/pairings.
router.get('/pairings', requireAuth, requireRole, async (req, res) => {
  try {
    const { role, affiliateId, username, isOrgWide: sessionOrgWide } = req.session.user;
    const isOrgWide = ORG_WIDE_ROLES.includes(role)
      || ORG_WIDE_NAMES.includes((username || '').toLowerCase())
      || !!sessionOrgWide;

    const params = [];
    let affWhere = '';
    if (!isOrgWide || req.query.affiliate_id) {
      const affId = isOrgWide ? req.query.affiliate_id : affiliateId;
      params.push(affId);
      affWhere = `AND m."affiliate_id" = $1`;
    }

    const { rows } = await pool.query(`
      SELECT
        p."id"          AS "pairingId",
        m."id"          AS "momId",
        m."first_name" || ' ' || m."last_name" AS "momName",
        t."title"       AS "trackTitle",
        p."status"::text AS "status",
        p."created_at"  AS "startDate",
        p."completed_on" AS "endDate"
      FROM "Pairing" p
      JOIN "Mom" m  ON m."id" = p."momId" AND m."deleted_at" = 0
      LEFT JOIN "Track" t ON t."id" = p."trackId"
      WHERE p."deleted_at" = 0
        AND (p."status"::text = 'paired' OR p."status"::text = 'pairing_complete')
        ${affWhere}
      ORDER BY
        CASE WHEN p."status"::text = 'paired' THEN 0 ELSE 1 END,
        p."created_at" DESC NULLS LAST
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('[court-summary] /pairings error:', err.message);
    res.status(500).json({ error: 'Failed to load pairings' });
  }
});

// GET /api/court-summary/:pairingId — full court report data for one pairing
router.get('/:pairingId', requireAuth, requireRole, async (req, res) => {
  try {
    const { role, affiliateId, username } = req.session.user;
    const { pairingId } = req.params;
    const isOrgWide = ORG_WIDE_ROLES.includes(role)
      || ORG_WIDE_NAMES.includes((username || '').toLowerCase());

    const params = [pairingId];
    let affFilter = '';
    if (!isOrgWide) {
      params.push(affiliateId);
      affFilter = `AND m."affiliate_id" = $2`;
    }

    // ── Pairing + mom + affiliate + advocate + coordinator ──────────────────
    // Coordinator resolution mirrors track-journey priority chain.
    const { rows: pRows } = await pool.query(`
      WITH this_pairing AS (
        SELECT p."id", p."momId"
        FROM "Pairing" p
        WHERE p."id" = $1 AND p."deleted_at" = 0
      ),
      coord_candidates AS (
        SELECT m."id" AS mom_id, m."assigned_user_id" AS coordinator_id,
               u."firstName" AS coord_first, u."lastName" AS coord_last,
               0 AS priority, m."updated_at" AS sort_date
        FROM "Mom" m
        JOIN "User" u ON u."id" = m."assigned_user_id"
        WHERE m."id" IN (SELECT "momId" FROM this_pairing)
          AND m."assigned_user_id" IS NOT NULL
        UNION ALL
        SELECT p."momId", atc."A",
               u."firstName", u."lastName",
               1, p."created_at"
        FROM "Pairing" p
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = p."advocateUserId"
        JOIN "User" u ON u."id" = atc."A"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               u."firstName", u."lastName",
               2, p."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = ag."advocateId"
        JOIN "User" u ON u."id" = atc."A"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT cn."mom_id", cn."coordinator_id",
               u."firstName", u."lastName",
               5, cn."created_at"
        FROM "CoordinatorNote" cn
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE cn."mom_id" IN (SELECT "momId" FROM this_pairing)
          AND cn."deleted_at" = 0
      ),
      coord AS (
        SELECT DISTINCT ON (mom_id)
          mom_id, coord_first, coord_last
        FROM coord_candidates
        ORDER BY mom_id, priority ASC, sort_date DESC NULLS LAST
      )
      SELECT
        p."id",
        p."trackId",
        p."momId",
        p."advocacyGroupId",
        m."first_name"   AS "momFirst",
        m."last_name"    AS "momLast",
        t."title"        AS "trackTitle",
        t."description"  AS "trackDescription",
        p."status"::text AS "status",
        p."advocacy_type"::text AS "advocacyType",
        p."created_at"   AS "startDate",
        p."completed_on" AS "endDate",
        adv."firstName"  AS "advFirst",
        adv."lastName"   AS "advLast",
        c."coord_first",
        c."coord_last",
        aff."name"       AS "affiliateName"
      FROM "Pairing" p
      JOIN "Mom" m          ON m."id" = p."momId"
      LEFT JOIN "Track" t   ON t."id" = p."trackId"
      LEFT JOIN "AdvocacyGroup" ag_pair ON ag_pair."id" = p."advocacyGroupId" AND ag_pair."deleted_at" = 0
      LEFT JOIN "User" adv  ON adv."id" = COALESCE(p."advocateUserId", ag_pair."advocateId")
      LEFT JOIN coord c     ON c.mom_id = p."momId"
      LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
      WHERE p."id" = $1 AND p."deleted_at" = 0
        ${affFilter}
    `, params);

    if (pRows.length === 0) return res.status(404).json({ error: 'Pairing not found' });
    const p = pRows[0];

    // ── Sessions with per-session note status ────────────────────────────────
    // Only sessions that have at least one SessionNote or are already Held/NotHeld.
    // Support sessions will be date-filtered on the client to track date range.
    //
    // noteStatus: best status for this session (approved > submitted > new).
    // engagement: from SessionNote (1:1 only; null for group, graceful fallback).
    let sessRows = [];
    try {
      ({ rows: sessRows } = await pool.query(`
        SELECT
          s."id",
          CASE
            WHEN s."date_start" IS NOT NULL THEN s."date_start"
            WHEN s."status"::text = 'Held'  THEN s."updated_at"
            ELSE NULL
          END                      AS "date",
          s."session_type"::text   AS "type",
          s."advocacy_group_id"    AS "advocacyGroupId",
          sa."status"::text        AS "momAttended",
          sa."promptness"::text    AS "promptness",
          -- Best SessionNote status for this session
          (SELECT DISTINCT ON (sn2."session_id") sn2."status"::text
             FROM "SessionNote" sn2
            WHERE sn2."session_id" = s."id"
              AND sn2."deleted_at" = 0
            ORDER BY sn2."session_id",
              CASE sn2."status"::text
                WHEN 'approved'  THEN 1
                WHEN 'submitted' THEN 2
                WHEN 'new'       THEN 3
                ELSE 4
              END
          )                        AS "noteStatus",
          -- Engagement from best approved/submitted note (1:1 only)
          CASE WHEN s."advocacy_group_id" IS NULL THEN
            (SELECT sn3."engagement"::text
               FROM "SessionNote" sn3
              WHERE sn3."session_id" = s."id"
                AND sn3."deleted_at" = 0
                AND sn3."status"::text IN ('approved', 'submitted')
              ORDER BY CASE sn3."status"::text WHEN 'approved' THEN 1 ELSE 2 END
              LIMIT 1)
          ELSE NULL END            AS "engagement",
          COALESCE(
            s."lesson_template_id",
            (SELECT l."source_lesson_template_id"
               FROM "SessionNote" sn
               JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
              WHERE sn."session_id" = s."id"
                AND sn."deleted_at" = 0
                AND sn."covered_lesson_id" IS NOT NULL
              ORDER BY sn."date_submitted_c" DESC NULLS LAST
              LIMIT 1)
          )                        AS "lessonTemplateId",
          COALESCE(
            (SELECT l."title"
               FROM "SessionNote" sn
               JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
              WHERE sn."session_id" = s."id"
                AND sn."deleted_at" = 0
                AND sn."covered_lesson_id" IS NOT NULL
              ORDER BY sn."date_submitted_c" DESC NULLS LAST
              LIMIT 1),
            s."name"
          )                        AS "sessionName"
        FROM "Session" s
        LEFT JOIN "SessionAttendance" sa
          ON sa."session_id" = s."id"
         AND sa."mom_id"     = $3
         AND sa."deleted_at" = 0
        WHERE s."deleted_at" = 0
          AND (
            s."pairing_id" = $1
            OR ($2::text IS NOT NULL AND s."advocacy_group_id" = $2)
          )
          AND (
            EXISTS (SELECT 1 FROM "SessionNote" sn WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0)
            OR s."status"::text IN ('Held', 'NotHeld')
          )
        ORDER BY COALESCE(s."date_start", s."updated_at") ASC NULLS LAST
      `, [pairingId, p.advocacyGroupId, p.momId]));
    } catch (err) {
      // Fallback: engagement column may not exist on SessionNote
      console.warn('[court-summary] session query with engagement failed, retrying without:', err.message);
      try {
        ({ rows: sessRows } = await pool.query(`
          SELECT
            s."id",
            CASE
              WHEN s."date_start" IS NOT NULL THEN s."date_start"
              WHEN s."status"::text = 'Held'  THEN s."updated_at"
              ELSE NULL
            END                      AS "date",
            s."session_type"::text   AS "type",
            s."advocacy_group_id"    AS "advocacyGroupId",
            sa."status"::text        AS "momAttended",
            sa."promptness"::text    AS "promptness",
            NULL::text               AS "engagement",
            (SELECT DISTINCT ON (sn2."session_id") sn2."status"::text
               FROM "SessionNote" sn2
              WHERE sn2."session_id" = s."id"
                AND sn2."deleted_at" = 0
              ORDER BY sn2."session_id",
                CASE sn2."status"::text WHEN 'approved' THEN 1 WHEN 'submitted' THEN 2 WHEN 'new' THEN 3 ELSE 4 END
            )                        AS "noteStatus",
            COALESCE(
              s."lesson_template_id",
              (SELECT l."source_lesson_template_id"
                 FROM "SessionNote" sn JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
                WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0
                  AND sn."covered_lesson_id" IS NOT NULL
                ORDER BY sn."date_submitted_c" DESC NULLS LAST LIMIT 1)
            )                        AS "lessonTemplateId",
            COALESCE(
              (SELECT l."title" FROM "SessionNote" sn JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
               WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0
                 AND sn."covered_lesson_id" IS NOT NULL
               ORDER BY sn."date_submitted_c" DESC NULLS LAST LIMIT 1),
              s."name"
            )                        AS "sessionName"
          FROM "Session" s
          LEFT JOIN "SessionAttendance" sa
            ON sa."session_id" = s."id" AND sa."mom_id" = $3 AND sa."deleted_at" = 0
          WHERE s."deleted_at" = 0
            AND (s."pairing_id" = $1 OR ($2::text IS NOT NULL AND s."advocacy_group_id" = $2))
            AND (
              EXISTS (SELECT 1 FROM "SessionNote" sn WHERE sn."session_id" = s."id" AND sn."deleted_at" = 0)
              OR s."status"::text IN ('Held', 'NotHeld')
            )
          ORDER BY COALESCE(s."date_start", s."updated_at") ASC NULLS LAST
        `, [pairingId, p.advocacyGroupId, p.momId]));
      } catch (_) {}
    }

    // ── Lesson templates (with description) ────────────────────────────────
    let lessonTemplates = [];
    try {
      if (p.trackId) {
        const { rows: ltRows } = await pool.query(`
          SELECT lt."id", lt."title", lt."description", lt."order"
          FROM "LessonTemplate" lt
          WHERE lt."track_id" = $1 AND lt."deleted_at" = 0
          ORDER BY lt."order" ASC
        `, [p.trackId]);
        lessonTemplates = ltRows.map(lt => ({
          id:          lt.id,
          name:        lt.title,
          description: lt.description || null,
          order:       lt.order,
        }));
      }
    } catch (_) {}

    // ── Per-pairing Lesson rows (completion status) ─────────────────────────
    let lessons = [];
    try {
      const { rows: lRows } = await pool.query(`
        SELECT
          l."id",
          l."source_lesson_template_id" AS "lessonTemplateId",
          l."status"::text              AS "status",
          CASE
            WHEN l."title" ~ '^(Lesson|Lecci[óo]n)\\s+\\d+' THEN l."title"
            WHEN lt."title" IS NOT NULL THEN lt."title"
            ELSE l."title"
          END                            AS "title",
          l."order",
          (SELECT MAX(s."date_start")
             FROM "SessionNote" sn
             JOIN "Session" s ON s."id" = sn."session_id" AND s."deleted_at" = 0
            WHERE sn."covered_lesson_id" = l."id"
              AND sn."deleted_at" = 0 AND s."date_start" IS NOT NULL
          )                              AS "completedDate"
        FROM "Lesson" l
        LEFT JOIN "LessonTemplate" lt
          ON lt."id" = l."source_lesson_template_id" AND lt."deleted_at" = 0
        WHERE l."pairing_id" = $1
        ORDER BY l."order" ASC NULLS LAST
      `, [pairingId]);
      lessons = lRows;
    } catch (_) {}

    // ── Assessments (exact same logic as track-journey) ─────────────────────
    const trackTitleLc = (p.trackTitle || '').toLowerCase();
    let trackGroup = null;
    if (/nurturing|crianza con/.test(trackTitleLc))                       trackGroup = 'NPP';
    else if (/empowered parenting|crianza empoderada/.test(trackTitleLc)) trackGroup = 'EP';
    else if (/resilience|hoja de ruta/.test(trackTitleLc))                trackGroup = 'RR';

    let assessmentNameFilter = '';
    if (trackGroup === 'EP') {
      assessmentNameFilter = `AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%')`;
    } else if (trackGroup === 'RR') {
      assessmentNameFilter = `AND (a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%')`;
    } else if (trackGroup === 'NPP') {
      assessmentNameFilter = `AND FALSE`;
    }

    let assessments = { pre: null, post: null };
    try {
      const { rows: aRows } = await pool.query(`
        SELECT
          ar."id"                                         AS "arId",
          COALESCE(ar."completedAt", ar."lastSaved")      AS "date",
          a."name"                                        AS "aname",
          ar."type"::text                                 AS "atype",
          (SELECT SUM(arqr."intResponse")::int
             FROM "AssessmentResultQuestionResponse" arqr
            WHERE arqr."assessmentResultId" = ar."id"
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL) AS "total_score"
        FROM "AssessmentResult" ar
        JOIN "Assessment" a ON a."id" = ar."assessmentId"
        JOIN "Pairing" pr ON pr."id" = $1 AND pr."deleted_at" = 0
        WHERE ar."momId" = pr."momId"
          AND a."name" NOT ILIKE '%Legacy%'
          AND ar."deleted_at" = 0
          ${assessmentNameFilter}
          AND COALESCE(ar."completedAt", ar."lastSaved") >= pr."created_at" - INTERVAL '30 days'
          AND (pr."completed_on" IS NULL
               OR COALESCE(ar."completedAt", ar."lastSaved") <= pr."completed_on" + INTERVAL '60 days')
        ORDER BY COALESCE(ar."completedAt", ar."lastSaved")
      `, [pairingId]);

      for (const r of aRows) {
        const isPre = (r.atype === 'pre') || /pre/i.test(r.aname);
        const payload = { arId: r.arId, date: r.date, name: r.aname, totalScore: r.total_score };
        if (isPre  && !assessments.pre)  assessments.pre  = payload;
        if (!isPre && !assessments.post) assessments.post = payload;
      }

      // Domain-level construct rollup (EP/RR)
      const resultIds = [assessments.pre?.arId, assessments.post?.arId].filter(Boolean);
      if (resultIds.length > 0) {
        try {
          const ph = resultIds.map((_, i) => `$${i + 1}`).join(', ');
          const { rows: dRows } = await pool.query(`
            SELECT
              arqr."assessmentResultId"           AS result_id,
              COALESCE(ac."name", 'Overall Score') AS construct_name,
              COALESCE(ac."order", 0)              AS construct_order,
              SUM(arqr."intResponse")::int         AS sum_score,
              COUNT(*)::int                        AS question_count
            FROM "AssessmentResultQuestionResponse" arqr
            JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId" AND aq."deleted_at" = 0
            JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId" AND ar."deleted_at" = 0
            JOIN "Assessment" a ON a."id" = ar."assessmentId" AND a."name" NOT ILIKE '%Legacy%'
            LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId" AND ac."deleted_at" = 0
            WHERE arqr."assessmentResultId" IN (${ph})
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL
            GROUP BY arqr."assessmentResultId", ac."id", ac."name", ac."order"
            ORDER BY arqr."assessmentResultId", COALESCE(ac."order", 0)
          `, resultIds);
          const byId = {};
          for (const d of dRows) {
            if (!byId[d.result_id]) byId[d.result_id] = [];
            byId[d.result_id].push({ name: d.construct_name, order: d.construct_order, score: d.sum_score, count: d.question_count });
          }
          if (assessments.pre  && byId[assessments.pre.arId])  assessments.pre.domains  = byId[assessments.pre.arId];
          if (assessments.post && byId[assessments.post.arId]) assessments.post.domains = byId[assessments.post.arId];
        } catch (_) {}
      }

      // NPP — AAPIScore
      if (trackGroup === 'NPP' && !assessments.pre && !assessments.post) {
        const { rows: aapiRows } = await pool.query(`
          SELECT s."created_at" AS "date",
                 s."constructAPreAssessment",  s."constructBPreAssessment",
                 s."constructCPreAssessment",  s."constructDPreAssessment",
                 s."constructEPreAssessment",
                 s."constructAPostAssessment", s."constructBPostAssessment",
                 s."constructCPostAssessment", s."constructDPostAssessment",
                 s."constructEPostAssessment"
            FROM "AAPIScore" s
            JOIN "Pairing" pr ON pr."id" = $1 AND pr."deleted_at" = 0
           WHERE s."mom_id" = pr."momId"
             AND s."deleted_at" = 0
             AND s."legacy_ps_id" IS NULL
             AND s."created_at" >= pr."created_at" - INTERVAL '30 days'
             AND (pr."completed_on" IS NULL OR s."created_at" <= pr."completed_on" + INTERVAL '60 days')
           ORDER BY s."created_at"
           LIMIT 1
        `, [pairingId]);
        if (aapiRows.length) {
          const r = aapiRows[0];
          const preParts  = [r.constructAPreAssessment,  r.constructBPreAssessment,  r.constructCPreAssessment,  r.constructDPreAssessment,  r.constructEPreAssessment];
          const postParts = [r.constructAPostAssessment, r.constructBPostAssessment, r.constructCPostAssessment, r.constructDPostAssessment, r.constructEPostAssessment];
          if (preParts.some(v => v != null)) {
            assessments.pre = {
              date: r.date, name: 'AAPI Assessment', type: 'pre',
              totalScore: preParts.reduce((s, v) => s + (v || 0), 0),
              constructs: { A: r.constructAPreAssessment, B: r.constructBPreAssessment, C: r.constructCPreAssessment, D: r.constructDPreAssessment, E: r.constructEPreAssessment },
            };
          }
          if (postParts.some(v => v != null)) {
            assessments.post = {
              date: r.date, name: 'AAPI Assessment', type: 'post',
              totalScore: postParts.reduce((s, v) => s + (v || 0), 0),
              constructs: { A: r.constructAPostAssessment, B: r.constructBPostAssessment, C: r.constructCPostAssessment, D: r.constructDPostAssessment, E: r.constructEPostAssessment },
            };
          }
        }
      }
    } catch (_) {}

    // ── Action plan goals ───────────────────────────────────────────────────
    // Try the most likely Trellis table names; graceful fallback if not found.
    let goals = { completed: [], inProgress: [] };
    try {
      const { rows: goalRows } = await pool.query(`
        SELECT
          g."id",
          g."name"            AS "name",
          g."status"::text    AS "status",
          g."due_date"        AS "dueDate",
          g."completed_at"    AS "completedAt",
          (SELECT COUNT(*)::int FROM "GoalSubtask" st WHERE st."goal_id" = g."id" AND st."deleted_at" = 0)     AS "subtaskCount",
          (SELECT COUNT(*)::int FROM "GoalSubtask" st WHERE st."goal_id" = g."id" AND st."deleted_at" = 0 AND st."completed_at" IS NOT NULL) AS "subtasksDone"
        FROM "ActionPlanGoal" g
        WHERE g."pairing_id" = $1
          AND g."deleted_at" = 0
        ORDER BY g."completed_at" NULLS LAST, g."due_date" ASC NULLS LAST
      `, [pairingId]);

      for (const g of goalRows) {
        const obj = {
          id:            g.id,
          name:          g.name,
          status:        g.status,
          dueDate:       g.dueDate,
          completedAt:   g.completedAt,
          subtaskCount:  g.subtaskCount,
          subtasksDone:  g.subtasksDone,
        };
        if (g.completedAt || (g.status || '').toLowerCase() === 'completed') {
          goals.completed.push(obj);
        } else {
          goals.inProgress.push(obj);
        }
      }
    } catch (err) {
      console.warn('[court-summary] goals query failed (ActionPlanGoal table may not exist):', err.message);
    }

    res.json({
      pairing: {
        id:              p.id,
        momName:         `${p.momFirst} ${p.momLast}`.trim(),
        momId:           p.momId,
        trackTitle:      p.trackTitle  || null,
        trackDescription: p.trackDescription || null,
        status:          p.status,
        advocacyType:    p.advocacyType || null,
        startDate:       p.startDate,
        endDate:         p.endDate,
        advocateName:    p.advFirst ? `${p.advFirst} ${p.advLast}`.trim() : null,
        coordinatorName: p.coord_first ? `${p.coord_first} ${p.coord_last}`.trim() : null,
        affiliateName:   p.affiliateName || null,
      },
      sessions: sessRows,
      lessons,
      lessonTemplates,
      assessments,
      goals,
    });
  } catch (err) {
    console.error('[court-summary] /:pairingId error:', err.message);
    res.status(500).json({ error: 'Failed to load court summary' });
  }
});

module.exports = router;
