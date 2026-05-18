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
// Curriculum stall: track-session gap ≥30d with at least one support session in gap (historical).
// Communication stall: any held-session gap ≥14d, not subsumed by a curriculum stall band.
function computeStalls(sessions, pairingStart, pairingEnd) {
  // Group sessions may have status='Held' but date_start=NULL.
  // Drop null-dated sessions from the stall computation — they can't anchor
  // a gap calculation and would otherwise be treated as epoch (1970).
  const allHeld   = sessions.filter(s => s.status === 'Held' && s.date)
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

  // ── Communication stalls (held-session gap ≥14d, not inside a curriculum stall) ──
  const gp = [winStart, ...allHeld.map(s => new Date(s.date)), winEnd];
  for (let i = 0; i < gp.length - 1; i++) {
    const d0 = gp[i], d1 = gp[i + 1];
    const days = (d1 - d0) / 86400000;
    if (days < 14) continue;
    const inCurr = currRanges.some(([cs, ce]) => d0 >= cs && d1 <= ce);
    if (inCurr) continue;
    result.push({
      type:      'communication',
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
      const commStall = dsh !== null && dsh >= 14;
      const currStall = dst !== null && dst >= 30;
      let stall = null;
      if (commStall || currStall) {
        stall = {
          type: (commStall && currStall) ? 'both' : currStall ? 'curriculum' : 'communication',
          days: currStall ? dst : dsh,
        };
      }
      return {
        pairingId:  p.pairingId,
        momId:      p.momId,
        momName:    p.momName,
        trackTitle: p.trackTitle,
        status:     p.status,
        startDate:  p.startDate,
        endDate:    p.endDate,
        stall,
      };
    });

    res.json(pairings);
  } catch (err) {
    console.error('[track-journey] /pairings error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load pairings' });
  }
});

// GET /api/track-journey/debug-schema — admin-only schema probe for ConnectionLog + ServiceReferral
router.get('/debug-schema', requireAuth, requireRole, async (req, res) => {
  try {
    const { role, username } = req.session.user;
    const isAllowed = ORG_WIDE_ROLES.includes(role)
      || ORG_WIDE_NAMES.includes((username || '').toLowerCase());
    if (!isAllowed) return res.status(403).json({ error: 'Admin only' });

    const tables = ['ConnectionLog', 'ServiceReferral'];
    const out = {};
    for (const tbl of tables) {
      try {
        const { rows: cols } = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
           WHERE table_name = $1
           ORDER BY ordinal_position
        `, [tbl]);
        out[tbl] = { columns: cols, exists: cols.length > 0 };
        if (cols.length > 0) {
          try {
            const { rows: sample } = await pool.query(`SELECT * FROM "${tbl}" LIMIT 3`);
            out[tbl].sample = sample;
          } catch (_) { out[tbl].sample = null; }
        }
      } catch (e) {
        out[tbl] = { exists: false, error: e.message };
      }
    }

    // Also scan for any table names containing 'connection' or 'referral'
    const { rows: related } = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name ILIKE '%connection%' OR table_name ILIKE '%referral%' OR table_name ILIKE '%contact%')
       ORDER BY table_name
    `);
    out._relatedTables = related.map(r => r.table_name);

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/track-journey/debug/sessions?mom=<momId>
// Admin-only diagnostic — dumps Session schema + every Session row reachable
// from a mom via her pairings, plus her pairings' AdvocacyGroup links.
// Used to diagnose group-delivered tracks where pairing_id may be null on
// the Session row.
router.get('/debug/sessions', requireAuth, requireRole, async (req, res) => {
  try {
    const { role, username } = req.session.user;
    const isAllowed = ORG_WIDE_ROLES.includes(role)
      || ORG_WIDE_NAMES.includes((username || '').toLowerCase());
    if (!isAllowed) return res.status(403).json({ error: 'Admin only' });

    const momId = req.query.mom;
    if (!momId) return res.status(400).json({ error: 'mom query param required' });

    const out = {};

    // 1. Session column list
    const { rows: cols } = await pool.query(`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = 'Session'
       ORDER BY ordinal_position
    `);
    out.sessionColumns = cols;

    // 2. Mom's pairings (with group link if present)
    const { rows: pairings } = await pool.query(`
      SELECT p."id", p."status"::text AS status, p."created_at" AS "startDate",
             p."completed_on" AS "endDate", p."advocateUserId",
             p."trackId", t."title" AS "trackTitle",
             p."advocacyGroupId"
        FROM "Pairing" p
        LEFT JOIN "Track" t ON t."id" = p."trackId"
       WHERE p."momId" = $1 AND p."deleted_at" = 0
       ORDER BY p."created_at" DESC
    `, [momId]);
    out.pairings = pairings;

    // 3. Sessions by pairing_id for each pairing
    out.sessionsByPairing = {};
    for (const p of pairings) {
      const { rows } = await pool.query(`
        SELECT s."id", s."date_start" AS date, s."status"::text AS status,
               s."session_type"::text AS type, s."pairing_id", s."deleted_at"
          FROM "Session" s
         WHERE s."pairing_id" = $1
         ORDER BY s."date_start"
      `, [p.id]);
      out.sessionsByPairing[p.id] = rows;
    }

    // 4. Sessions by advocacy_group_id (if column exists) for each pairing's group
    const hasGroupCol = cols.some(c => c.column_name === 'advocacy_group_id');
    out.hasAdvocacyGroupIdOnSession = hasGroupCol;
    out.sessionsByGroup = {};
    if (hasGroupCol) {
      for (const p of pairings) {
        if (!p.advocacyGroupId) continue;
        const { rows } = await pool.query(`
          SELECT s."id", s."date_start" AS date, s."status"::text AS status,
                 s."session_type"::text AS type, s."pairing_id",
                 s."advocacy_group_id", s."deleted_at"
            FROM "Session" s
           WHERE s."advocacy_group_id" = $1
           ORDER BY s."date_start"
        `, [p.advocacyGroupId]);
        out.sessionsByGroup[p.advocacyGroupId] = rows;
      }
    }

    // 5. Find Vital Support / Needs table — Trellis surfaces this as
    //    /vital-support with need_type, status, urgent, context_for_need.
    //    Probe likely table names and capture columns + sample row for this mom.
    const candidateTables = ['Need','VitalSupport','VitalSupportNeed','MomNeed','SupportNeed','VitalNeed','Needs','BenevolenceNeed'];
    out.vitalSupportProbe = {};
    for (const tbl of candidateTables) {
      try {
        const { rows: tcols } = await pool.query(`
          SELECT column_name, data_type
            FROM information_schema.columns
           WHERE table_name = $1
           ORDER BY ordinal_position
        `, [tbl]);
        if (!tcols.length) continue;
        out.vitalSupportProbe[tbl] = { columns: tcols };

        // Try to fetch rows for this mom — guess at the mom-FK column name.
        const momFkCol = tcols.find(c => /mom/i.test(c.column_name))?.column_name;
        if (momFkCol) {
          const { rows: tRows } = await pool.query(
            `SELECT * FROM "${tbl}" WHERE "${momFkCol}" = $1 LIMIT 5`,
            [momId]
          );
          out.vitalSupportProbe[tbl].sampleRows = tRows;
          out.vitalSupportProbe[tbl].momFkColumn = momFkCol;
        }
      } catch (_) { /* table doesn't exist — skip */ }
    }

    // 6. Also scan for any table whose name contains vital/need
    const { rows: matchTables } = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name ILIKE '%vital%' OR table_name ILIKE '%need%' OR table_name ILIKE '%support%')
       ORDER BY table_name
    `);
    out.vitalLikeTables = matchTables.map(r => r.table_name);

    res.json(out);
  } catch (err) {
    console.error('[track-journey] /debug/sessions error:', err.message);
    res.status(500).json({ error: err.message });
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

    // Coordinator resolution for this pairing's mom.
    // Priority 0: Mom.assigned_user_id — the direct Trellis "Assigned
    // Coordinator" field. Works for both 1:1 and group pairings.
    // Confirmed: Elbony Ingram's assigned_user_id = Babie-Marie Henriquez.
    //
    // Priority 1-4: _AdvocateToCoordinator (A=coord, B=advocate).
    // Priority 5-9: CoordinatorNote fallback (history only).
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
        SELECT p."momId" AS mom_id, atc."A" AS coordinator_id,
               u."firstName" AS coord_first, u."lastName" AS coord_last,
               1 AS priority, p."created_at" AS sort_date
        FROM "Pairing" p
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = p."advocateUserId"
        JOIN "User" u ON u."id" = atc."A"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
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
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               u."firstName", u."lastName",
               3, p."created_at"
        FROM "Pairing" p
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = p."advocateUserId"
        JOIN "User" u ON u."id" = atc."A"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               u."firstName", u."lastName",
               4, p."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = ag."advocateId"
        JOIN "User" u ON u."id" = atc."A"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT cn."mom_id" AS mom_id, cn."coordinator_id",
               u."firstName", u."lastName",
               5, cn."created_at"
        FROM "CoordinatorNote" cn
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE cn."mom_id" IN (SELECT "momId" FROM this_pairing)
          AND cn."deleted_at" = 0
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               u."firstName", u."lastName",
               6, cn."created_at"
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn
          ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               u."firstName", u."lastName",
               7, cn."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "CoordinatorNote" cn
          ON cn."advocate_id" = ag."advocateId" AND cn."deleted_at" = 0
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text = 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               u."firstName", u."lastName",
               8, cn."created_at"
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn
          ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               u."firstName", u."lastName",
               9, cn."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "CoordinatorNote" cn
          ON cn."advocate_id" = ag."advocateId" AND cn."deleted_at" = 0
        JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE p."momId" IN (SELECT "momId" FROM this_pairing)
          AND p."deleted_at" = 0
          AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text = 'group'
      ),
      coord AS (
        SELECT DISTINCT ON (mom_id)
          mom_id, coordinator_id, coord_first, coord_last
        FROM coord_candidates
        ORDER BY mom_id, priority ASC, sort_date DESC NULLS LAST
      )
      SELECT
        p."id",
        p."momId"        AS "momId",
        p."advocacyGroupId" AS "advocacyGroupId",
        m."first_name"   AS "momFirst",
        m."last_name"    AS "momLast",
        t."title"        AS "trackTitle",
        p."status"::text AS "status",
        p."advocacy_type"::text AS "advocacyType",
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
      LEFT JOIN coord c      ON c.mom_id = p."momId"
      WHERE p."id" = $1
        AND p."deleted_at" = 0
        ${affFilter}
    `, params);

    if (pRows.length === 0) {
      return res.status(404).json({ error: 'Pairing not found' });
    }
    const p = pRows[0];

    // Sessions for this pairing.
    // Group-delivered tracks (NPP-in-a-group) store Sessions with
    // pairing_id=NULL but with advocacy_group_id set. Pull by either:
    //   - direct pairing_id match (individual track), OR
    //   - this pairing's advocacy_group_id (group track)
    // Group sessions are group-level events shared by all members of the
    // group; we surface them on each member's Track Journey.
    //
    // For group sessions, Session.status reflects whether the COHORT met
    // (Held / NotHeld / Planned), not whether THIS mom attended. Per-mom
    // attendance lives in SessionAttendance (enum: 'Present' | 'Absent').
    // We LEFT JOIN it and derive the mom's effective status:
    //   - SessionAttendance row exists → 'Held' if Present, 'NotHeld' if Absent
    //   - No row (1:1 sessions, or unfilled group attendance) → fall back to Session.status
    // The original cohort status is preserved as `groupStatus` for any
    // future visual treatment that wants to distinguish "cohort met but
    // mom absent" from "cohort didn't meet".
    let sessRows;
    try {
      ({ rows: sessRows } = await pool.query(`
        SELECT s."id",
               s."date_start"         AS "date",
               s."status"::text       AS "groupStatus",
               sa."status"::text      AS "momAttended",
               CASE
                 WHEN sa."status"::text = 'Present' THEN 'Held'
                 WHEN sa."status"::text = 'Absent'  THEN 'NotHeld'
                 ELSE s."status"::text
               END                    AS "status",
               s."session_type"::text AS "type",
               s."description"        AS "notes",
               s."lesson_template_id" AS "lessonTemplateId",
               s."name"               AS "sessionName"
          FROM "Session" s
          LEFT JOIN "SessionAttendance" sa
            ON sa."session_id" = s."id"
           AND sa."mom_id"     = $3
           AND sa."deleted_at" = 0
         WHERE s."deleted_at" = 0
           AND (
             s."pairing_id" = $1
             OR (
               $2::text IS NOT NULL
               AND s."advocacy_group_id" = $2
             )
           )
         ORDER BY s."date_start" NULLS LAST
      `, [pairingId, p.advocacyGroupId, p.momId]));
    } catch (_) {
      ({ rows: sessRows } = await pool.query(`
        SELECT s."id",
               s."date_start"         AS "date",
               s."status"::text       AS "groupStatus",
               NULL::text             AS "momAttended",
               s."status"::text       AS "status",
               s."session_type"::text AS "type",
               NULL::text             AS "notes",
               NULL::text             AS "lessonTemplateId",
               NULL::text             AS "sessionName"
          FROM "Session" s
         WHERE s."pairing_id" = $1
           AND s."deleted_at" = 0
         ORDER BY s."date_start"
      `, [pairingId]));
    }

    // Number Track_Sessions by unique lesson template (repeats of same lesson share a number)
    let lessonNum = 0;
    const seenTemplates = new Map();
    const sessions = sessRows.map(s => {
      let lnum = null;
      if (s.type === 'Track_Session') {
        const tid = s.lessonTemplateId;
        if (tid) {
          if (!seenTemplates.has(tid)) seenTemplates.set(tid, ++lessonNum);
          lnum = seenTemplates.get(tid);
        } else {
          lnum = ++lessonNum;
        }
      }
      return {
        id:               s.id,
        date:             s.date,
        status:           s.status,
        groupStatus:      s.groupStatus  || null,
        momAttended:      s.momAttended  || null,
        type:             s.type,
        notes:            s.notes,
        lessonNumber:     lnum,
        lessonTemplateId: s.lessonTemplateId || null,
        sessionName:      s.sessionName      || null,
      };
    });

    // Stall computation
    const stalls = computeStalls(sessions, p.startDate, p.endDate);

    // Current stall for header — only count Held sessions that have a real
    // date_start. Some group sessions are recorded as Held but without a
    // date and can't anchor a stall calc.
    const heldSessions  = sessions.filter(s => s.status === 'Held' && s.date);
    const lastHeld      = heldSessions.at(-1)?.date ?? null;
    const lastHeldTrack = sessions.filter(s => s.status === 'Held' && s.type === 'Track_Session' && s.date).at(-1)?.date ?? null;
    const dsh = daysSince(lastHeld);
    const dst = daysSince(lastHeldTrack);
    let currentStall = null;
    if (p.status === 'paired') {
      if (dst !== null && dst >= 30)       currentStall = { type: 'curriculum', days: dst };
      else if (dsh !== null && dsh >= 14)  currentStall = { type: 'general',    days: dsh };
    }

    // Assessment marks — pre + post for EP/RR (AssessmentResult) and NPP (AAPIScore).
    // Each side includes name, date, type, and a total_score when computable.
    //
    // Track scoping (P1 fix): AssessmentResult has NO pairing_id column, so a
    // mom with multi-track history would otherwise see assessments from the
    // wrong track. Two filters applied:
    //   1. Assessment.name matches this pairing's track type (EP / RR).
    //   2. completedAt falls within this pairing's window (with grace before
    //      start_date to capture pre-assessments completed at intake).
    // NPP pairings skip AssessmentResult entirely (they use AAPIScore below).
    const trackTitleLc = (p.trackTitle || '').toLowerCase();
    let trackGroup = null;
    if (/nurturing|crianza con/.test(trackTitleLc))            trackGroup = 'NPP';
    else if (/empowered parenting|crianza empoderada/.test(trackTitleLc)) trackGroup = 'EP';
    else if (/resilience|hoja de ruta/.test(trackTitleLc))     trackGroup = 'RR';

    let assessmentNameFilter = '';
    if (trackGroup === 'EP') {
      assessmentNameFilter = `AND (a."name" ILIKE 'Empowered Parenting%' OR a."name" ILIKE 'Crianza empoderada%')`;
    } else if (trackGroup === 'RR') {
      assessmentNameFilter = `AND (a."name" ILIKE 'Resilience%' OR a."name" ILIKE 'Hoja de ruta%')`;
    } else if (trackGroup === 'NPP') {
      assessmentNameFilter = `AND FALSE`; // NPP uses AAPIScore, not AssessmentResult
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
              AND arqr."intResponse" IS NOT NULL) AS "total_score",
          (SELECT COUNT(*)::int
             FROM "AssessmentResultQuestionResponse" arqr
            WHERE arqr."assessmentResultId" = ar."id"
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL) AS "questions_answered"
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
        const payload = {
          arId: r.arId,
          date: r.date,
          name: r.aname,
          type: isPre ? 'pre' : 'post',
          totalScore: r.total_score,
          questionsAnswered: r.questions_answered,
        };
        if (isPre  && !assessments.pre)  assessments.pre  = payload;
        if (!isPre && !assessments.post) assessments.post = payload;
      }

      // Per-question breakdown for EP/RR — one bar per question in the UI
      const resultIds = [
        assessments.pre  && assessments.pre.arId,
        assessments.post && assessments.post.arId,
      ].filter(Boolean);
      if (resultIds.length > 0) {
        try {
          const ph = resultIds.map((_, i) => `$${i + 1}`).join(', ');
          const { rows: qRows } = await pool.query(`
            SELECT
              arqr."assessmentResultId"  AS result_id,
              aq."question"              AS label,
              aq."order"                 AS q_order,
              arqr."intResponse"         AS score,
              ac."name"                  AS construct_name,
              ac."order"                 AS construct_order
            FROM "AssessmentResultQuestionResponse" arqr
            JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId"
              AND aq."deleted_at" = 0
            LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId"
              AND ac."deleted_at" = 0
            WHERE arqr."assessmentResultId" IN (${ph})
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL
            ORDER BY ac."order" ASC NULLS LAST, aq."order" ASC
          `, resultIds);
          const { rows: scaleRows } = await pool.query(`
            SELECT MIN(arqr."intResponse") AS scale_min,
                   MAX(arqr."intResponse") AS scale_max
            FROM "AssessmentResultQuestionResponse" arqr
            JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
            JOIN "Assessment" a        ON a."id"  = ar."assessmentId"
            WHERE a."name" NOT ILIKE '%Legacy%'
              AND ar."deleted_at"   = 0
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL
          `);
          if (qRows.length > 0) {
            const scale = (scaleRows.length && scaleRows[0].scale_min != null)
              ? { min: Number(scaleRows[0].scale_min), max: Number(scaleRows[0].scale_max) }
              : null;
            const byId = {};
            for (const q of qRows) {
              const rid = q.result_id;
              if (!byId[rid]) byId[rid] = [];
              byId[rid].push({
                label: q.label,
                order: q.q_order,
                score: q.score,
                constructName: q.construct_name,
                constructOrder: q.construct_order,
              });
            }
            if (assessments.pre  && byId[assessments.pre.arId]) {
              assessments.pre.questions = byId[assessments.pre.arId];
              if (scale) assessments.pre.scale = scale;
            }
            if (assessments.post && byId[assessments.post.arId]) {
              assessments.post.questions = byId[assessments.post.arId];
              if (scale) assessments.post.scale = scale;
            }
          }
        } catch (qErr) {
          console.warn('[track-journey] per-question enrichment failed:', qErr.message);
        }
      }

      // NPP — AAPIScore (5 constructs A–E, pre+post on same row). Only run
      // for NPP pairings, and scope temporally to this pairing's window so a
      // mom with multiple NPP enrollments doesn't see the wrong cycle's
      // scores. Match report-data.js semantics: AAPIScore.created_at falls
      // within this pairing's life span.
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
           ORDER BY s."created_at" DESC
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

    // ConnectionLog — coordinator contact entries keyed by mom_id.
    // Used by the stall drawer outreach count and activity feed.
    let connectionLogs = [];
    try {
      const { rows: clRows } = await pool.query(`
        SELECT
          cl."id",
          cl."date_created_c"            AS "date",
          cl."summary_c"                 AS "summary",
          cl."contact_method_c"::text    AS "contactMethod",
          cl."created_by_name"           AS "createdByName",
          cl."is_visible_to_advocates_c" AS "visibleToAdvocate"
        FROM "ConnectionLog" cl
        WHERE cl."mom_id" = $1
          AND cl."deleted_at" = 0
        ORDER BY cl."date_created_c" DESC
        LIMIT 50
      `, [p.momId]);
      connectionLogs = clRows;
    } catch (_) { /* connection log unavailable */ }

    // Coordinator notes — recent entries written about this pairing's advocate.
    // Used by the stall drawer; graceful if advocate is unset or table query fails.
    let coordinatorNotes = [];
    try {
      // Pull coordinator notes directly linked to this pairing's mom.
      // (Previously joined on cn.advocate_id = p.advocateUserId, which
      //  surfaced notes about the advocate — wrong entity — and returned
      //  nothing for group pairings where advocateUserId is NULL.)
      const { rows: noteRows } = await pool.query(`
        SELECT
          cn."created_at"  AS "date",
          cn."description" AS "text",
          u."firstName"    AS "coordFirst",
          u."lastName"     AS "coordLast"
        FROM "CoordinatorNote" cn
        LEFT JOIN "User" u ON u."id" = cn."coordinator_id"
        WHERE cn."mom_id" = (
              SELECT "momId" FROM "Pairing"
               WHERE "id" = $1 AND "deleted_at" = 0)
          AND cn."deleted_at" = 0
        ORDER BY cn."created_at" DESC
        LIMIT 20
      `, [pairingId]);
      coordinatorNotes = noteRows.map(r => ({
        date:            r.date,
        text:            r.text,
        coordinatorName: r.coordFirst ? `${r.coordFirst} ${r.coordLast}`.trim() : null,
      }));
    } catch (_) { /* coordinator notes unavailable */ }

    // ServiceReferrals — linked to mom, joinable to BenevolenceNeed via benevolence_need_id.
    let serviceReferrals = [];
    try {
      const { rows: srRows } = await pool.query(`
        SELECT
          sr."id",
          sr."service"::text        AS "service",
          sr."outcome"::text        AS "outcome",
          sr."provider"             AS "provider",
          sr."start_date"           AS "startDate",
          sr."created_at"           AS "createdAt",
          sr."created_by_name"      AS "createdByName",
          sr."benevolence_need_id"  AS "benevolenceNeedId"
        FROM "ServiceReferral" sr
        WHERE sr."mom_id" = $1
          AND sr."deleted_at" = 0
        ORDER BY sr."start_date" DESC
      `, [p.momId]);
      serviceReferrals = srRows;
    } catch (_) { /* service referrals unavailable */ }

    // Vital Supports / Flagged Needs — BenevolenceNeed rows for this mom,
    // plus any group-level needs tied to this pairing's advocacy group.
    // Surfaces the same data as Trellis's "Vital Support" tab.
    let vitalNeeds = [];
    try {
      const { rows: needRows } = await pool.query(`
        SELECT
          bn."id",
          bn."created_at"           AS "requestedDate",
          bn."type_c"::text         AS "needType",
          bn."name"                 AS "name",
          bn."description"          AS "context",
          bn."is_urgent_c"          AS "urgent",
          bn."did_address_need_c"   AS "addressed",
          bn."provided_date_c"      AS "providedDate",
          bn."resolved_date_c"      AS "resolvedDate",
          bn."notes_c"              AS "notes",
          bn."advocacyGroupId"      AS "advocacyGroupId",
          bn."group_need_category_c"::text AS "groupNeedCategory"
        FROM "BenevolenceNeed" bn
        WHERE bn."deleted_at" = 0
          AND (
            bn."momId" = $1
            OR ($2::text IS NOT NULL AND bn."advocacyGroupId" = $2)
          )
        ORDER BY COALESCE(bn."resolved_date_c", bn."provided_date_c", bn."created_at") DESC
      `, [p.momId, p.advocacyGroupId]);
      vitalNeeds = needRows.map(r => {
        const sr = serviceReferrals.find(s => s.benevolenceNeedId === r.id) || null;
        return {
          id:            r.id,
          date:          r.providedDate || r.requestedDate,
          requestedDate: r.requestedDate,
          providedDate:  r.providedDate,
          resolvedDate:  r.resolvedDate,
          needType:      r.needType || r.groupNeedCategory || r.name,
          context:       r.context,
          urgent:        r.urgent === true,
          status:        r.addressed === true ? 'Fulfilled'
                       : r.resolvedDate          ? 'Resolved'
                       : 'Requested',
          notes:         r.notes,
          serviceReferral: sr ? {
            id:            sr.id,
            service:       sr.service,
            outcome:       sr.outcome,
            provider:      sr.provider,
            startDate:     sr.startDate,
            createdByName: sr.createdByName,
          } : null,
        };
      });
    } catch (_) { /* vital needs unavailable */ }

    res.json({
      pairing: {
        id:              p.id,
        momName:         `${p.momFirst} ${p.momLast}`.trim(),
        trackTitle:      p.trackTitle,
        status:          p.status,
        advocacyType:    p.advocacyType || null,
        startDate:       p.startDate,
        endDate:         p.endDate,
        advocateName:    p.advFirst ? `${p.advFirst} ${p.advLast}`.trim() : null,
        coordinatorName: p.coord_first ? `${p.coord_first} ${p.coord_last}`.trim() : null,
        currentStall,
      },
      sessions,
      stalls,
      assessments,
      coordinatorNotes,
      connectionLogs,
      vitalNeeds,
    });
  } catch (err) {
    console.error('[track-journey] /:pairingId error:', err.message);
    res.status(500).json({ error: 'Failed to load track journey' });
  }
});

module.exports = router;
