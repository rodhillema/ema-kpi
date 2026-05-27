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
  const trackHeld = allHeld.filter(s => !!s.lessonTemplateId);

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

    // Step 2: fetch last-activity dates for stall detection using SessionNote.date_submitted_c.
    // Session.status='Held' misses lessons marked complete via SessionNote in Trellis.
    // Uses Session.mom_id to cover both 1:1 and group pairings.
    let lastHeldMap = {};
    if (rows.length > 0) {
      const ids    = rows.map(r => r.pairingId);
      const momIds = rows.map(r => r.momId);
      const momToPairing = Object.fromEntries(rows.map(r => [r.momId, r.pairingId]));
      try {
        const { rows: stallRows } = await pool.query(`
          SELECT
            s."mom_id"                                            AS "momId",
            MAX(sn."date_submitted_c")                            AS "lastHeldAt",
            MAX(CASE WHEN sn."covered_lesson_id" IS NOT NULL
                     THEN sn."date_submitted_c" END)              AS "lastHeldTrackAt"
          FROM "SessionNote" sn
          JOIN "Session" s ON s."id" = sn."session_id"
            AND s."deleted_at" = 0
            AND s."mom_id" = ANY($1)
          WHERE sn."deleted_at" = 0
            AND sn."date_submitted_c" IS NOT NULL
          GROUP BY s."mom_id"
        `, [momIds]);
        for (const r of stallRows) {
          const pid = momToPairing[r.momId];
          if (pid) lastHeldMap[pid] = { lastHeldAt: r.lastHeldAt, lastHeldTrackAt: r.lastHeldTrackAt };
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

// GET /api/track-journey/debug-schema — admin-only schema probe
router.get('/debug-schema', requireAuth, requireRole, async (req, res) => {
  try {
    const { role, username } = req.session.user;
    const isAllowed = ORG_WIDE_ROLES.includes(role)
      || ORG_WIDE_NAMES.includes((username || '').toLowerCase());
    if (!isAllowed) return res.status(403).json({ error: 'Admin only' });

    const tables = ['ConnectionLog', 'ServiceReferral', 'SessionNote'];
    const out = {};
    for (const tbl of tables) {
      try {
        const { rows: cols } = await pool.query(`
          SELECT column_name, data_type, udt_name, is_nullable, column_default
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

    // Session.type enum values — confirm what values exist in production
    try {
      const { rows: typeVals } = await pool.query(`
        SELECT s."session_type"::text AS type_val, COUNT(*)::int AS cnt
          FROM "Session" s
         WHERE s."deleted_at" = 0
         GROUP BY 1
         ORDER BY 2 DESC
      `);
      out._sessionTypeValues = typeVals;
    } catch (e) {
      out._sessionTypeValues = { error: e.message };
    }

    // Group sessions with lesson_template_id set but type != Track_Session
    // These are the "mislabeled" sessions: they have a lesson assigned (so they
    // ARE curriculum sessions) but the type field disagrees.
    try {
      const { rows: mislabeled } = await pool.query(`
        SELECT
          s."id",
          s."session_type"::text    AS "type",
          s."status"::text          AS "status",
          s."lesson_template_id"    AS "lessonTemplateId",
          s."name"                  AS "sessionName",
          s."date_start"            AS "date",
          s."advocacy_group_id"     AS "advocacyGroupId",
          s."pairing_id"            AS "pairingId",
          ag."name"                 AS "groupName",
          t."title"                 AS "trackTitle"
        FROM "Session" s
        LEFT JOIN "AdvocacyGroup" ag ON ag."id" = s."advocacy_group_id" AND ag."deleted_at" = 0
        LEFT JOIN "Track" t ON t."id" = ag."trackId" AND t."deleted_at" = 0
        WHERE s."deleted_at" = 0
          AND s."advocacy_group_id" IS NOT NULL
          AND s."lesson_template_id" IS NOT NULL
          AND s."session_type"::text <> 'Track_Session'
        ORDER BY s."date_start" DESC NULLS LAST
        LIMIT 20
      `);
      out._mislabeledGroupSessions = {
        sample: mislabeled,
        note: 'Group sessions (advocacy_group_id IS NOT NULL) with lesson_template_id set but type != Track_Session',
      };
    } catch (e) {
      out._mislabeledGroupSessions = { error: e.message };
    }

    // Count summary of group sessions by type + whether lesson_template_id is set
    try {
      const { rows: summary } = await pool.query(`
        SELECT
          s."session_type"::text                              AS "type",
          (s."lesson_template_id" IS NOT NULL)::text         AS "hasLesson",
          COUNT(*)::int                                       AS "cnt"
        FROM "Session" s
        WHERE s."deleted_at" = 0
          AND s."advocacy_group_id" IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
      `);
      out._groupSessionTypeSummary = summary;
    } catch (e) {
      out._groupSessionTypeSummary = { error: e.message };
    }

    // Also scan for any table names containing 'connection' or 'referral'
    const { rows: related } = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name ILIKE '%connection%' OR table_name ILIKE '%referral%'
              OR table_name ILIKE '%contact%' OR table_name ILIKE '%session%')
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
               s."session_type"::text AS type, s."lesson_template_id", s."pairing_id", s."deleted_at"
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
                 s."session_type"::text AS type, s."lesson_template_id", s."pairing_id",
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
        p."trackId"      AS "trackId",
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
      LEFT JOIN "AdvocacyGroup" ag_pair ON ag_pair."id" = p."advocacyGroupId" AND ag_pair."deleted_at" = 0
      LEFT JOIN "User" adv   ON adv."id" = COALESCE(p."advocateUserId", ag_pair."advocateId")
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
               CASE
                 WHEN s."date_start" IS NOT NULL THEN s."date_start"
                 WHEN s."status"::text = 'Held'  THEN s."updated_at"
                 ELSE NULL
               END                    AS "date",
               s."status"::text       AS "groupStatus",
               sa."status"::text      AS "momAttended",
               sa."promptness"::text  AS "promptness",
               CASE
                 -- Group: attendance record present
                 WHEN sa."status"::text = 'Present' THEN 'Held'
                 WHEN sa."status"::text = 'Absent'  THEN 'NotHeld'
                 -- Group: no attendance record — cohort held, assume mom was there
                 WHEN s."advocacy_group_id" IS NOT NULL
                      AND s."status"::text = 'Held'
                      AND sa."status" IS NULL
                      THEN 'Unmarked'
                 -- 1:1: "No show" promptness overrides Session.status = Held
                 WHEN s."advocacy_group_id" IS NULL
                      AND sa."promptness"::text = 'No show'
                      THEN 'NotHeld'
                 -- General: any session with a SUBMITTED SessionNote is effectively held.
                 -- Trellis often leaves Session.status='Planned' even after the coordinator
                 -- approves a SessionNote for it. Applies to Track and Support alike — the
                 -- Lesson table remains the authoritative curriculum-completion source so
                 -- this promotion doesn't double-count curriculum progress.
                 WHEN s."status"::text = 'Planned'
                      AND EXISTS (
                        SELECT 1 FROM "SessionNote" sn
                         WHERE sn."session_id" = s."id"
                           AND sn."deleted_at" = 0
                           AND sn."date_submitted_c" IS NOT NULL
                      )
                      THEN 'Held'
                 ELSE s."status"::text
               END                    AS "status",
               s."session_type"::text  AS "type",
               s."description"        AS "notes",
               -- Project lesson info from the linked SessionNote when the Session itself
               -- has no lesson_template_id. Coordinators sometimes create the Session
               -- without picking a lesson template, then submit a SessionNote with
               -- covered_lesson_id pointing to the Lesson row. We use the latest such
               -- SessionNote (preferring submitted ones) so the timeline can show the
               -- session against its real lesson position.
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
               )                       AS "lessonTemplateId",
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
               )                       AS "sessionName"
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
         ORDER BY COALESCE(s."date_start", s."updated_at") NULLS LAST
      `, [pairingId, p.advocacyGroupId, p.momId]));
    } catch (_) {
      // Fallback: promptness column may not exist — keep full SA join and lesson_template_id
      // so group attendance and curriculum counting still work correctly.
      ({ rows: sessRows } = await pool.query(`
        SELECT s."id",
               CASE
                 WHEN s."date_start" IS NOT NULL THEN s."date_start"
                 WHEN s."status"::text = 'Held'  THEN s."updated_at"
                 ELSE NULL
               END                    AS "date",
               s."status"::text       AS "groupStatus",
               sa."status"::text      AS "momAttended",
               NULL::text             AS "promptness",
               CASE
                 WHEN sa."status"::text = 'Present' THEN 'Held'
                 WHEN sa."status"::text = 'Absent'  THEN 'NotHeld'
                 WHEN s."advocacy_group_id" IS NOT NULL
                      AND s."status"::text = 'Held'
                      AND sa."status" IS NULL
                      THEN 'Unmarked'
                 -- General SessionNote-based promotion (see primary query for rationale).
                 WHEN s."status"::text = 'Planned'
                      AND EXISTS (
                        SELECT 1 FROM "SessionNote" sn
                         WHERE sn."session_id" = s."id"
                           AND sn."deleted_at" = 0
                           AND sn."date_submitted_c" IS NOT NULL
                      )
                      THEN 'Held'
                 ELSE s."status"::text
               END                    AS "status",
               s."session_type"::text AS "type",
               s."description"        AS "notes",
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
               )                       AS "lessonTemplateId",
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
               )                       AS "sessionName"
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
         ORDER BY COALESCE(s."date_start", s."updated_at") NULLS LAST
      `, [pairingId, p.advocacyGroupId, p.momId]));
    }

    // Lesson templates — all templates for this track, ordered by sequence.
    // Drives Curriculum Detail: correct names, ordering, and not-started rows.
    // Tries the Prisma camelCase FK ("trackId"); wrapped in try/catch so a
    // schema mismatch falls back gracefully and the frontend uses static titles.
    // LessonTemplate column names: lt.title (NOT lt.name) and lt.track_id (NOT
    // lt.trackId). The earlier query used the wrong column names, fell into the
    // catch silently, and returned [] for every pairing — which is why the
    // curriculum number resolution couldn't fall back to LessonTemplate-name
    // parsing and the sort order kept relying on the inconsistent Lesson.order.
    // We alias lt.title → name in the response so downstream code (this file
    // and the frontend ltMap) keeps treating the field as `name`.
    let lessonTemplates = [];
    try {
      if (p.trackId) {
        const { rows: ltRows } = await pool.query(`
          SELECT lt."id", lt."title", lt."order"
          FROM "LessonTemplate" lt
          WHERE lt."track_id" = $1
            AND lt."deleted_at" = 0
          ORDER BY lt."order" ASC
        `, [p.trackId]);
        lessonTemplates = ltRows.map(lt => ({
          id:    lt.id,
          name:  lt.title,
          order: lt.order,
        }));
      }
    } catch (_) {
      // LessonTemplate query failed — frontend uses static LESSON_TITLES fallback.
    }

    // Per-pairing Lesson rows — Lesson.status='completed' is the authoritative
    // curriculum completion state in Trellis, more reliable than Session.status='Held'.
    // completedDate is when the SESSION actually happened (Session.date_start), pulled
    // through the linking SessionNote. We use date_start, not SessionNote.date_submitted_c,
    // because coordinators routinely submit notes a day after the session — using the
    // submission date would shift the displayed "last held" date forward incorrectly.
    //
    // Title resolution: join the matching LessonTemplate directly via
    // source_lesson_template_id so we don't depend on the separate lessonTemplates
    // query (which is keyed off Pairing.trackId and silently returns nothing for some
    // pairings where the trackId doesn't line up). If Lesson.title lacks a
    // "Lesson N|" / "Lección N|" prefix, substitute LessonTemplate.title which
    // reliably carries the prefix per the Trellis Lesson Templates table.
    let lessons = [];
    try {
      const { rows: lRows } = await pool.query(`
        SELECT
          l."id",
          l."source_lesson_template_id"   AS "lessonTemplateId",
          l."status"::text                AS "status",
          CASE
            WHEN l."title" ~ '^(Lesson|Lecci[óo]n)\\s+\\d+' THEN l."title"
            WHEN lt."title" IS NOT NULL THEN lt."title"
            ELSE l."title"
          END                              AS "title",
          l."order",
          (SELECT MAX(s."date_start")
             FROM "SessionNote" sn
             JOIN "Session" s ON s."id" = sn."session_id" AND s."deleted_at" = 0
            WHERE sn."covered_lesson_id" = l."id"
              AND sn."deleted_at" = 0
              AND s."date_start" IS NOT NULL
          )                                AS "completedDate"
        FROM "Lesson" l
        LEFT JOIN "LessonTemplate" lt
          ON lt."id" = l."source_lesson_template_id"
         AND lt."deleted_at" = 0
        WHERE l."pairing_id" = $1
        ORDER BY l."order" ASC NULLS LAST
      `, [pairingId]);
      lessons = lRows;
    } catch (_) { /* Lesson table unavailable — frontend falls back to session-based count */ }

    // Map templateId → curriculum lesson number (1-indexed). Sources in priority:
    //   1. Per-pairing Lesson title parsing: "Lesson 8 | ..." → 8. This is the most
    //      reliable source — Trellis's user-facing curriculum names are 1-indexed
    //      and the parsed number always matches the curriculum position.
    //   2. Per-pairing Lesson.order, with 0→1 normalization. Trellis stores some
    //      lessons 0-indexed (Kenna Anderson's NPP rows) and some 1-indexed
    //      (Aniyah Childress's NPP rows), so we treat any non-negative order as
    //      "shift by 1 if it would otherwise be 0" to land on a 1-indexed display.
    //   3. LessonTemplate name parsing, then lt.order normalized the same way.
    function normalizeOrderToLessonNum(orderVal) {
      if (orderVal == null) return null;
      const n = parseInt(orderVal, 10);
      if (isNaN(n)) return null;
      // Treat 0 as "this is 0-indexed data" — bump to 1. Any higher value is
      // assumed to already be 1-indexed (1..N) and used as-is.
      return n === 0 ? 1 : n;
    }
    // Title-parse regex handles both English ("Lesson 8 | ...") and Spanish
    // ("Lección 4 | ..." or "Leccion 4 | ...") — Hoja de Ruta and Crianza
    // tracks use Spanish lesson titles. Language-agnostic so both EN and ES
    // pairings number correctly.
    const LESSON_TITLE_RE = /^(?:Lesson|Lecci[óo]n)\s+(\d+)/i;
    // Resolve curriculum number for a templateId across all available sources.
    // Priority order matters: per-pairing Lesson.title may be customized but is
    // unreliable (some RR pairings store only the descriptive part with no
    // "Lección N|" prefix); LessonTemplate.name from the master template is the
    // most stable source; orders are last-resort and inconsistent across pairings.
    const ltById = {};
    for (const lt of lessonTemplates) { ltById[lt.id] = lt; }
    function curriculumNumForLesson(l) {
      if (l.title) {
        const m = String(l.title).match(LESSON_TITLE_RE);
        if (m) return parseInt(m[1], 10);
      }
      const lt = l.lessonTemplateId && ltById[l.lessonTemplateId];
      if (lt && lt.name) {
        const m = String(lt.name).match(LESSON_TITLE_RE);
        if (m) return parseInt(m[1], 10);
      }
      let n = normalizeOrderToLessonNum(l.order);
      if (n != null) return n;
      if (lt) n = normalizeOrderToLessonNum(lt.order);
      return n;
    }
    const templateLessonNumMap = {};
    for (const l of lessons) {
      if (!l.lessonTemplateId) continue;
      const num = curriculumNumForLesson(l);
      if (num != null) templateLessonNumMap[l.lessonTemplateId] = num;
    }
    // Any LessonTemplates not represented by a per-pairing Lesson row (rare —
    // would mean the pairing skipped a curriculum slot) still get a number.
    for (const lt of lessonTemplates) {
      if (templateLessonNumMap[lt.id] != null) continue;
      let num = null;
      if (lt.name) {
        const m = String(lt.name).match(LESSON_TITLE_RE);
        if (m) num = parseInt(m[1], 10);
      }
      if (num == null) num = normalizeOrderToLessonNum(lt.order);
      if (num != null) templateLessonNumMap[lt.id] = num;
    }

    // Number Track_Sessions by lesson template — use curriculum number from the
    // template name, not encounter order, so lessonNumber matches the actual
    // lesson position rather than the chronological session sequence.
    let fallbackNum = 0;
    const seenTemplates = new Map();
    const sessions = sessRows.map(s => {
      let lnum = null;
      if (s.type === 'Track_Session') {
        const tid = s.lessonTemplateId;
        if (tid) {
          if (!seenTemplates.has(tid)) {
            const mapped = templateLessonNumMap[tid];
            seenTemplates.set(tid, mapped !== undefined ? mapped : ++fallbackNum);
          }
          lnum = seenTemplates.get(tid);
        }
        // Untemplated Track_Sessions: lnum stays null (shown in "additional" bucket)
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

    // Count sessions with no lesson template linked in Trellis.
    // Non-zero means curriculum progress may be underreported (see Trellis data-entry gap).
    const untemplatedCount      = sessions.filter(s => !s.lessonTemplateId).length;
    const heldUntemplatedCount  = sessions.filter(s => !s.lessonTemplateId
      && s.status === 'Held').length;

    // SessionNote activity dates — true completion evidence for stall computation.
    // Covers lessons marked complete via SessionNote even when Session.status='Planned'.
    let noteActivitySessions = [];
    try {
      const { rows: snRows } = await pool.query(`
        SELECT
          sn."date_submitted_c"                      AS date,
          (sn."covered_lesson_id" IS NOT NULL)::bool AS "isCurriculum",
          l."source_lesson_template_id"              AS "lessonTemplateId"
        FROM "SessionNote" sn
        JOIN "Session" s ON s."id" = sn."session_id"
          AND s."deleted_at" = 0
          AND s."mom_id" = $1
        LEFT JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
        WHERE sn."deleted_at" = 0
          AND sn."date_submitted_c" IS NOT NULL
        ORDER BY sn."date_submitted_c" ASC
      `, [p.momId]);
      noteActivitySessions = snRows.map(r => ({
        date:             r.date,
        status:           'Held',
        type:             r.isCurriculum ? 'Track_Session' : 'Support_Session',
        lessonTemplateId: r.lessonTemplateId || null,
      }));
    } catch (_) { /* SessionNote unavailable — stall computation uses Session.status only */ }

    // Merge note activity with session data, deduplicating same-day same-lesson events.
    const sessionHeldDayKeys = new Set(
      sessions
        .filter(s => s.status === 'Held' && s.date)
        .map(s => new Date(s.date).toISOString().slice(0, 10) + ':' + (s.lessonTemplateId || ''))
    );
    const dedupedNoteActivity = noteActivitySessions.filter(n => {
      const key = new Date(n.date).toISOString().slice(0, 10) + ':' + (n.lessonTemplateId || '');
      return !sessionHeldDayKeys.has(key);
    });
    const sessionsForStall = [...sessions, ...dedupedNoteActivity]
      .filter(s => s.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Stall computation uses note-augmented session list.
    const stalls = computeStalls(sessionsForStall, p.startDate, p.endDate);

    // Last activity date — derived from SessionNote-augmented list.
    const heldForStall   = sessionsForStall.filter(s => s.status === 'Held' && s.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const lastActivityDate      = heldForStall.at(-1)?.date ?? null;
    const lastCurrActivityDate  = heldForStall.filter(s => !!s.lessonTemplateId).at(-1)?.date ?? null;
    const dsh = daysSince(lastActivityDate);
    const dst = daysSince(lastCurrActivityDate);
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

      // Domain-level rollup for EP/RR — one bar per construct, not per question.
      // LEFT JOIN so RR questions with null assessmentConstructId still aggregate;
      // those fall back to a single "Overall Score" domain (COALESCE).
      const resultIds = [
        assessments.pre  && assessments.pre.arId,
        assessments.post && assessments.post.arId,
      ].filter(Boolean);
      if (resultIds.length > 0) {
        try {
          const ph = resultIds.map((_, i) => `$${i + 1}`).join(', ');
          const { rows: dRows } = await pool.query(`
            SELECT
              arqr."assessmentResultId"                    AS result_id,
              COALESCE(ac."name", 'Overall Score')         AS construct_name,
              COALESCE(ac."order", 0)                      AS construct_order,
              AVG(arqr."intResponse")                      AS mean_score,
              COUNT(*)::int                                AS question_count
            FROM "AssessmentResultQuestionResponse" arqr
            JOIN "AssessmentQuestion" aq ON aq."id" = arqr."assessmentQuestionId"
              AND aq."deleted_at" = 0
            JOIN "AssessmentResult" ar ON ar."id" = arqr."assessmentResultId"
              AND ar."deleted_at" = 0
            JOIN "Assessment" a ON a."id" = ar."assessmentId"
              AND a."name" NOT ILIKE '%Legacy%'
            LEFT JOIN "AssessmentConstruct" ac ON ac."id" = aq."assessmentConstructId"
              AND ac."deleted_at" = 0
            WHERE arqr."assessmentResultId" IN (${ph})
              AND arqr."deleted_at" = 0
              AND arqr."intResponse" IS NOT NULL
            GROUP BY arqr."assessmentResultId", ac."id", ac."name", ac."order"
            ORDER BY arqr."assessmentResultId", COALESCE(ac."order", 0) ASC
          `, resultIds);
          if (dRows.length > 0) {
            const byId = {};
            for (const d of dRows) {
              const rid = d.result_id;
              if (!byId[rid]) byId[rid] = [];
              byId[rid].push({
                name:  d.construct_name,
                order: d.construct_order,
                mean:  parseFloat(parseFloat(d.mean_score).toFixed(2)),
                count: d.question_count,
              });
            }
            if (assessments.pre  && byId[assessments.pre.arId]) {
              assessments.pre.domains  = byId[assessments.pre.arId];
            }
            if (assessments.post && byId[assessments.post.arId]) {
              assessments.post.domains = byId[assessments.post.arId];
            }
          }
        } catch (dErr) {
          console.warn('[track-journey] domain enrichment failed:', dErr.message);
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
        id:               p.id,
        momName:          `${p.momFirst} ${p.momLast}`.trim(),
        trackTitle:       p.trackTitle,
        status:           p.status,
        advocacyType:     p.advocacyType || null,
        startDate:        p.startDate,
        endDate:          p.endDate,
        advocateName:     p.advFirst ? `${p.advFirst} ${p.advLast}`.trim() : null,
        coordinatorName:  p.coord_first ? `${p.coord_first} ${p.coord_last}`.trim() : null,
        currentStall,
        lastActivityDate, // SessionNote-aware last contact date for stall drawer display
      },
      sessions,
      stalls,
      assessments,
      lessons,
      lessonTemplates,
      coordinatorNotes,
      connectionLogs,
      vitalNeeds,
      untemplatedSessionCount:     untemplatedCount,
      heldUntemplatedSessionCount: heldUntemplatedCount,
    });
  } catch (err) {
    console.error('[track-journey] /:pairingId error:', err.message);
    res.status(500).json({ error: 'Failed to load track journey' });
  }
});

module.exports = router;
