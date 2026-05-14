'use strict';
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const ORG_WIDE_ROLES = ['administrator'];
const ORG_WIDE_NAMES = ['rd.hill', 'cristina.galloway'];

function daysSince(dt) {
  if (!dt) return null;
  return Math.floor((Date.now() - new Date(dt)) / 86400000);
}

// Compute historical stall bands from a session list.
// Returns [{type, startDate, endDate, days, isActive}]
// Curriculum stall: track-session gap ≥30d with at least one support session in gap.
// General stall:    any-session gap ≥14d, not subsumed by a curriculum stall.
function computeStalls(sessions, pairingStart, pairingEnd) {
  const allHeld   = sessions.filter(s => s.status === 'Held')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const trackHeld = allHeld.filter(s => s.type === 'Track_Session');

  const winStart = new Date(pairingStart);
  const winEnd   = pairingEnd ? new Date(pairingEnd) : new Date();
  const result   = [];
  const currRanges = [];

  // ── Curriculum stalls (track gap ≥30d, support session present in gap) ──
  const cp = [winStart, ...trackHeld.map(s => new Date(s.date)), winEnd];
  for (let i = 0; i < cp.length - 1; i++) {
    const d0 = cp[i], d1 = cp[i + 1];
    const days = (d1 - d0) / 86400000;
    if (days < 30) continue;
    const hasSupport = allHeld.some(s => {
      const sd = new Date(s.date);
      return s.type !== 'Track_Session' && sd > d0 && sd < d1;
    });
    if (!hasSupport) continue;
    result.push({
      type:      'curriculum',
      startDate: d0.toISOString(),
      endDate:   d1.toISOString(),
      days:      Math.round(days),
      isActive:  i === cp.length - 2,
    });
    currRanges.push([d0, d1]);
  }

  // ── General stalls (held-session gap ≥14d, not inside a curriculum stall) ──
  const gp = [winStart, ...allHeld.map(s => new Date(s.date)), winEnd];
  for (let i = 0; i < gp.length - 1; i++) {
    const d0 = gp[i], d1 = gp[i + 1];
    const days = (d1 - d0) / 86400000;
    if (days < 14) continue;
    const inCurr = currRanges.some(([cs, ce]) => d0 >= cs && d1 <= ce);
    if (inCurr) continue;
    result.push({
      type:      'general',
      startDate: d0.toISOString(),
      endDate:   d1.toISOString(),
      days:      Math.round(days),
      isActive:  i === gp.length - 2,
    });
  }

  return result;
}

// GET /api/track-journey/pairings — affiliate-scoped selector list
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

    console.log('[track-journey] /pairings — isOrgWide:', isOrgWide, 'role:', role, 'affWhere:', affWhere || '(none)', 'params:', params);

    // Step 1: base pairing list — no correlated subqueries in SELECT so the
    // query stays fast and avoids any enum-cast issues in nested subqueries.
    const { rows } = await pool.query(`
      SELECT
        p."id"          AS "pairingId",
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

    console.log('[track-journey] /pairings — base query returned', rows.length, 'rows');

    // Step 2: fetch last-held dates for stall detection in a single batch query.
    // Only run if there are rows to avoid an empty-IN error.
    let lastHeldMap = {};
    if (rows.length > 0) {
      const ids = rows.map(r => r.pairingId);
      try {
        const { rows: stallRows } = await pool.query(`
          SELECT
            s."pairing_id"                                     AS "pairingId",
            MAX(s."date_start")                                AS "lastHeldAt",
            MAX(CASE WHEN s."session_type"::text = 'Track_Session'
                     THEN s."date_start" END)                  AS "lastHeldTrackAt"
          FROM "Session" s
          WHERE s."pairing_id" = ANY($1)
            AND s."deleted_at" = 0
            AND s."status"::text = 'Held'
          GROUP BY s."pairing_id"
        `, [ids]);
        for (const r of stallRows) {
          lastHeldMap[r.pairingId] = { lastHeldAt: r.lastHeldAt, lastHeldTrackAt: r.lastHeldTrackAt };
        }
      } catch (stallErr) {
        console.error('[track-journey] stall sub-query failed (stall badges skipped):', stallErr.message);
      }
    }

    const pairings = rows.map(p => {
      const held = lastHeldMap[p.pairingId] || {};
      const dsh = daysSince(held.lastHeldAt);
      const dst = daysSince(held.lastHeldTrackAt);
      let stall = null;
      if (dst !== null && dst >= 30)       stall = { type: 'curriculum', days: dst };
      else if (dsh !== null && dsh >= 14)  stall = { type: 'general',    days: dsh };
      return {
        pairingId:  p.pairingId,
        momName:    p.momName,
        trackTitle: p.trackTitle,
        status:     p.status,
        stall,
      };
    });

    res.json(pairings);
  } catch (err) {
    console.error('[track-journey] /pairings error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load pairings' });
  }
});

// GET /api/track-journey/:pairingId — full journey data for one pairing
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

    // Pairing header + coordinator via most-recent CoordinatorNote pattern
    const { rows: pRows } = await pool.query(`
      WITH coord AS (
        SELECT DISTINCT ON (p2."id")
          p2."id"       AS pairing_id,
          u."firstName" AS coord_first,
          u."lastName"  AS coord_last
        FROM "Pairing" p2
        JOIN "CoordinatorNote" cn
          ON cn."advocate_id" = p2."advocateUserId"
         AND cn."deleted_at" = 0
        LEFT JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE p2."deleted_at" = 0
        ORDER BY p2."id", cn."created_at" DESC
      )
      SELECT
        p."id",
        m."first_name"   AS "momFirst",
        m."last_name"    AS "momLast",
        t."title"        AS "trackTitle",
        p."status"::text AS "status",
        p."created_at"   AS "startDate",
        p."completed_on" AS "endDate",
        adv."firstName"  AS "advFirst",
        adv."lastName"   AS "advLast",
        c."coord_first",
        c."coord_last"
      FROM "Pairing" p
      JOIN "Mom" m      ON m."id" = p."momId"
      LEFT JOIN "Track" t    ON t."id" = p."trackId"
      LEFT JOIN "User" adv   ON adv."id" = p."advocateUserId"
      LEFT JOIN coord c      ON c.pairing_id = p."id"
      WHERE p."id" = $1
        AND p."deleted_at" = 0
        ${affFilter}
    `, params);

    if (pRows.length === 0) {
      return res.status(404).json({ error: 'Pairing not found' });
    }
    const p = pRows[0];

    // Sessions — try with description column, fall back without it
    let sessRows;
    try {
      ({ rows: sessRows } = await pool.query(`
        SELECT s."id",
               s."date_start"         AS "date",
               s."status"::text       AS "status",
               s."session_type"::text AS "type",
               s."description"        AS "notes"
          FROM "Session" s
         WHERE s."pairing_id" = $1
           AND s."deleted_at" = 0
         ORDER BY s."date_start"
      `, [pairingId]));
    } catch (_) {
      ({ rows: sessRows } = await pool.query(`
        SELECT s."id",
               s."date_start"         AS "date",
               s."status"::text       AS "status",
               s."session_type"::text AS "type",
               NULL::text             AS "notes"
          FROM "Session" s
         WHERE s."pairing_id" = $1
           AND s."deleted_at" = 0
         ORDER BY s."date_start"
      `, [pairingId]));
    }

    // Number Track_Sessions sequentially by date
    let lessonNum = 0;
    const sessions = sessRows.map(s => ({
      id:           s.id,
      date:         s.date,
      status:       s.status,
      type:         s.type,
      notes:        s.notes,
      lessonNumber: s.type === 'Track_Session' ? ++lessonNum : null,
    }));

    // Stall computation
    const stalls = computeStalls(sessions, p.startDate, p.endDate);

    // Current stall for header
    const heldSessions  = sessions.filter(s => s.status === 'Held');
    const lastHeld      = heldSessions.at(-1)?.date ?? null;
    const lastHeldTrack = sessions.filter(s => s.status === 'Held' && s.type === 'Track_Session').at(-1)?.date ?? null;
    const dsh = daysSince(lastHeld);
    const dst = daysSince(lastHeldTrack);
    let currentStall = null;
    if (p.status === 'paired') {
      if (dst !== null && dst >= 30)       currentStall = { type: 'curriculum', days: dst };
      else if (dsh !== null && dsh >= 14)  currentStall = { type: 'general',    days: dsh };
    }

    // Assessment marks — pre + post for EP/RR (AssessmentResult) and NPP (AAPIScore).
    // Each side includes name, date, type, and a total_score when computable.
    let assessments = { pre: null, post: null };
    try {
      const { rows: aRows } = await pool.query(`
        SELECT
          ar."completedAt" AS "date",
          a."name"         AS "aname",
          ar."type"::text  AS "atype",
          (SELECT SUM(arqr."intResponse")::int
             FROM "AssessmentResultQuestionResponse" arqr
            WHERE arqr."assessmentResultId" = ar."id"
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL) AS "total_score",
          (SELECT COUNT(*)::int
             FROM "AssessmentResultQuestionResponse" arqr
            WHERE arqr."assessmentResultId" = ar."id"
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL) AS "questions_answered"
          FROM "AssessmentResult" ar
          JOIN "Assessment" a ON a."id" = ar."assessmentId"
         WHERE ar."momId" = (
               SELECT "momId" FROM "Pairing"
                WHERE "id" = $1 AND "deleted_at" = 0)
           AND a."name" NOT ILIKE '%Legacy%'
           AND ar."deleted_at" = 0
         ORDER BY ar."completedAt"
      `, [pairingId]);
      for (const r of aRows) {
        const isPre = (r.atype === 'pre') || /pre/i.test(r.aname);
        const payload = {
          date: r.date,
          name: r.aname,
          type: isPre ? 'pre' : 'post',
          totalScore: r.total_score,
          questionsAnswered: r.questions_answered,
        };
        if (isPre  && !assessments.pre)  assessments.pre  = payload;
        if (!isPre && !assessments.post) assessments.post = payload;
      }

      // NPP — AAPIScore (5 constructs A–E, pre+post on same row). Only fill
      // in if the EP/RR query didn't find anything (NPP tracks won't have
      // AssessmentResult rows for their curriculum).
      if (!assessments.pre && !assessments.post) {
        const { rows: aapiRows } = await pool.query(`
          SELECT "created_at" AS "date",
                 "constructAPreAssessment",  "constructBPreAssessment",
                 "constructCPreAssessment",  "constructDPreAssessment",
                 "constructEPreAssessment",
                 "constructAPostAssessment", "constructBPostAssessment",
                 "constructCPostAssessment", "constructDPostAssessment",
                 "constructEPostAssessment"
            FROM "AAPIScore"
           WHERE "mom_id" = (
                 SELECT "momId" FROM "Pairing"
                  WHERE "id" = $1 AND "deleted_at" = 0)
             AND "deleted_at" = 0
             AND "legacy_ps_id" IS NULL
           ORDER BY "created_at"
           LIMIT 1
        `, [pairingId]);
        if (aapiRows.length) {
          const r = aapiRows[0];
          const preParts  = [r.constructAPreAssessment,  r.constructBPreAssessment,  r.constructCPreAssessment,  r.constructDPreAssessment,  r.constructEPreAssessment];
          const postParts = [r.constructAPostAssessment, r.constructBPostAssessment, r.constructCPostAssessment, r.constructDPostAssessment, r.constructEPostAssessment];
          const hasPre  = preParts.some(v => v != null);
          const hasPost = postParts.some(v => v != null);
          if (hasPre) {
            assessments.pre = {
              date: r.date, name: 'AAPI Pre-Assessment', type: 'pre',
              totalScore: preParts.reduce((s, v) => s + (v || 0), 0),
              constructs: { A: r.constructAPreAssessment, B: r.constructBPreAssessment, C: r.constructCPreAssessment, D: r.constructDPreAssessment, E: r.constructEPreAssessment },
            };
          }
          if (hasPost) {
            assessments.post = {
              date: r.date, name: 'AAPI Post-Assessment', type: 'post',
              totalScore: postParts.reduce((s, v) => s + (v || 0), 0),
              constructs: { A: r.constructAPostAssessment, B: r.constructBPostAssessment, C: r.constructCPostAssessment, D: r.constructDPostAssessment, E: r.constructEPostAssessment },
            };
          }
        }
      }
    } catch (_) { /* assessment data unavailable */ }

    res.json({
      pairing: {
        id:              p.id,
        momName:         `${p.momFirst} ${p.momLast}`.trim(),
        trackTitle:      p.trackTitle,
        status:          p.status,
        startDate:       p.startDate,
        endDate:         p.endDate,
        advocateName:    p.advFirst ? `${p.advFirst} ${p.advLast}`.trim() : null,
        coordinatorName: p.coord_first ? `${p.coord_first} ${p.coord_last}`.trim() : null,
        currentStall,
      },
      sessions,
      stalls,
      assessments,
    });
  } catch (err) {
    console.error('[track-journey] /:pairingId error:', err.message);
    res.status(500).json({ error: 'Failed to load track journey' });
  }
});

module.exports = router;
