const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// All mom-status routes require auth + coordinator-or-above role
router.use(requireAuth, requireRole);

// GET /api/mom-status — list moms with status, coordinator, latest contact, FWA, current pairing, recent contact log
// Query params:
//   ?affiliate_id=<uuid>  — admin/supervisor filter to a specific affiliate
//   ?exclude_affiliate_id=<uuid> — admin "all except X" mode
router.get('/', async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role;

    // Champions blocked (page redirects them client-side too)
    if (role === 'champion') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build WHERE clause based on role
    const conditions = [`m."deleted_at" = 0`];
    const params = [];
    let paramIdx = 1;

    const ORG_WIDE_USERNAMES = ['cristina.galloway'];
    const isOrgWide = role === 'administrator' || ORG_WIDE_USERNAMES.includes((user.username || '').toLowerCase());

    if (!isOrgWide && role === 'coordinator') {
      // Coordinator sees all moms in their affiliate.
      // Frontend "My Moms" button further narrows to moms they're assigned to.
      conditions.push(`m."affiliate_id" = $${paramIdx}`);
      params.push(user.affiliateId);
      paramIdx++;
    } else if (role === 'supervisor' || role === 'staff_advocate') {
      conditions.push(`m."affiliate_id" = $${paramIdx}`);
      params.push(user.affiliateId);
      paramIdx++;
    } else if (isOrgWide) {
      if (req.query.exclude_affiliate_id) {
        conditions.push(`m."affiliate_id" != $${paramIdx}`);
        params.push(req.query.exclude_affiliate_id);
        paramIdx++;
      } else if (req.query.affiliate_id) {
        conditions.push(`m."affiliate_id" = $${paramIdx}`);
        params.push(req.query.affiliate_id);
        paramIdx++;
      }
    }

    const whereClause = conditions.join(' AND ');

    // Main query — one row per mom with core profile + coordinator + latest FWA + current pairing.
    // DISTINCT ON prevents duplicate rows when a mom has multiple pairings / coordinator assignments.
    const mainQuery = `
      WITH coord_for_mom AS (
        -- Coordinator = most recent CoordinatorNote author that references the mom's advocate.
        -- Same pattern we use in /api/advocates to derive coordinator when the _AdvocateToCoordinator
        -- join table is sparse.
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          cn."coordinator_id" AS coordinator_id,
          coord."firstName" AS coord_first,
          coord."lastName"  AS coord_last
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        LEFT JOIN "User" coord ON coord."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0
        ORDER BY p."momId", cn."created_at" DESC
      ),
      latest_fwa AS (
        SELECT DISTINCT ON (wa."mom_id")
          wa."mom_id" AS mom_id,
          wa."completed_date" AS fwa_date,
          wa."completed_ahead" AS completed_ahead
        FROM "WellnessAssessment" wa
        WHERE wa."deleted_at" = 0
        ORDER BY wa."mom_id", wa."created_at" DESC
      ),
      active_pairing AS (
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          p."id" AS pairing_id,
          p."trackId" AS track_id,
          p."created_at" AS pairing_started_at,
          t."title" AS track_title
        FROM "Pairing" p
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
        ORDER BY p."momId", p."created_at" DESC
      ),
      latest_session AS (
        -- Latest session of any type (Held / Planned / NotHeld) per mom.
        -- "Last contact" heuristic per Cristina's spec.
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          s."date_start" AS session_date,
          s."status"::text AS session_status
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        WHERE s."deleted_at" = 0
        ORDER BY p."momId", s."date_start" DESC
      ),
      intake_first_engaged AS (
        -- Derived from AuditLog (same pattern as report-data.js INTAKE_CTE).
        SELECT data->>'id' AS mom_id, MIN(created_at) AS engaged_date
        FROM "AuditLog"
        WHERE "table" = 'Mom' AND action = 'Update'
          AND data->>'prospect_status' = 'engaged_in_program'
        GROUP BY data->>'id'
      )
      SELECT
        m."id",
        m."first_name" AS "firstName",
        m."last_name"  AS "lastName",
        -- Mom has no single "phone" column. Fall back through the two mom-owned
        -- phone fields (phone_other / phone_alternate_c). referring_contact_phone_c
        -- intentionally excluded — that's the referrer's number, not the mom's.
        COALESCE(m."phone_other", m."phone_alternate_c") AS "phone",
        m."email1" AS "email",
        m."status"::text AS "status",
        m."affiliate_id" AS "affiliateId",
        aff."name" AS "affiliateName",
        cfm.coordinator_id AS "coordinatorId",
        cfm.coord_first AS "coordFirstName",
        cfm.coord_last  AS "coordLastName",
        lfwa.fwa_date AS "lastFwaDate",
        lfwa.completed_ahead AS "fwaCompletedAhead",
        ap.pairing_id AS "activePairingId",
        ap.track_title AS "activeTrackTitle",
        ap.pairing_started_at AS "pairingStartedAt",
        ls.session_date AS "lastSessionDate",
        ls.session_status AS "lastSessionStatus",
        COALESCE(lfwa.fwa_date, ife.engaged_date) AS "intakeDate",
        m."updated_at" AS "momUpdatedAt"
      FROM "Mom" m
      LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
      LEFT JOIN coord_for_mom cfm ON cfm.mom_id = m."id"
      LEFT JOIN latest_fwa lfwa ON lfwa.mom_id = m."id"
      LEFT JOIN active_pairing ap ON ap.mom_id = m."id"
      LEFT JOIN latest_session ls ON ls.mom_id = m."id"
      LEFT JOIN intake_first_engaged ife ON ife.mom_id = m."id"
      WHERE ${whereClause}
      ORDER BY m."last_name" ASC NULLS LAST, m."first_name" ASC NULLS LAST
    `;

    const { rows } = await pool.query(mainQuery, params);

    if (rows.length === 0) {
      return res.json([]);
    }

    const momIds = rows.map((r) => r.id);

    // Held-session count per active pairing — used for "sessions done" on the in-progress track.
    const sessionsQuery = `
      SELECT p."momId" AS mom_id, COUNT(*)::int AS held_sessions
      FROM "Session" s
      JOIN "Pairing" p ON p."id" = s."pairing_id"
      WHERE p."momId" = ANY($1)
        AND p."deleted_at" = 0
        AND p."status"::text = 'paired'
        AND s."deleted_at" = 0
        AND s."status"::text = 'Held'
      GROUP BY p."momId"
    `;
    const sessionsResult = await pool.query(sessionsQuery, [momIds]);
    const heldByMom = Object.fromEntries(sessionsResult.rows.map((r) => [r.mom_id, r.held_sessions]));

    // Contact log — last 5 entries per mom, blending Sessions and CoordinatorNotes.
    // Sessions come from any pairing the mom has had.
    // CoordinatorNotes come via the mom's advocate → coordinator_id / advocate_id match.
    const contactLogQuery = `
      WITH combined AS (
        SELECT p."momId" AS mom_id,
          s."date_start" AS log_date,
          s."status"::text AS log_type,
          NULL::text AS note_text,
          'session' AS source_kind
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        WHERE p."momId" = ANY($1)
          AND s."deleted_at" = 0
        UNION ALL
        SELECT p."momId" AS mom_id,
          cn."created_at" AS log_date,
          'Coordinator note' AS log_type,
          cn."description" AS note_text,
          'note' AS source_kind
        FROM "CoordinatorNote" cn
        JOIN "Pairing" p ON p."advocateUserId" = cn."advocate_id"
        WHERE p."momId" = ANY($1)
          AND cn."deleted_at" = 0
      ),
      ranked AS (
        SELECT mom_id, log_date, log_type, note_text, source_kind,
          ROW_NUMBER() OVER (PARTITION BY mom_id ORDER BY log_date DESC) AS rn
        FROM combined
      )
      SELECT mom_id, log_date, log_type, note_text, source_kind
      FROM ranked
      WHERE rn <= 5
      ORDER BY mom_id, log_date DESC
    `;
    const contactLogResult = await pool.query(contactLogQuery, [momIds]);
    const contactLogByMom = {};
    for (const r of contactLogResult.rows) {
      if (!contactLogByMom[r.mom_id]) contactLogByMom[r.mom_id] = [];
      contactLogByMom[r.mom_id].push({
        date: r.log_date,
        type: r.log_type,
        note: r.note_text || null,
      });
    }

    // Required-sessions lookup by track title — mirrors report-data.js REQUIRED_SESSIONS.
    const REQUIRED_SESSIONS = {
      'Nurturing Parenting Program': 10,
      'El programa de Crianza con cariño NPP': 10,
      'Empowered Parenting': 8,
      'Crianza empoderada EP': 8,
      'Roadmap to Resilience': 4,
      'Hoja de ruta hacia la resiliencia RR': 4,
    };

    // Days-since helper. Null-safe.
    function daysSince(d) {
      if (!d) return null;
      const then = new Date(d);
      if (Number.isNaN(then.getTime())) return null;
      return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Shape the response one mom at a time.
    const moms = rows.map((r) => {
      const firstName = r.firstName || '';
      const lastName = r.lastName || '';
      const fullName = `${firstName} ${lastName}`.trim();

      const coordFullName = r.coordFirstName
        ? `${r.coordFirstName} ${r.coordLastName || ''}`.trim()
        : null;

      let inProgressTrack = null;
      if (r.activePairingId && r.activeTrackTitle) {
        const sessionsTotal = REQUIRED_SESSIONS[r.activeTrackTitle] || null;
        const sessionsDone = heldByMom[r.id] || 0;
        const stalledDays = daysSince(r.lastSessionDate);
        const stalled = stalledDays != null && stalledDays > 14;
        // Normalize track title to NPP/EP/RR group code for filter bucketing.
        // Spanish track names share their English counterpart's group:
        //   "Crianza con cariño"    / "Nurturing Parenting"    → NPP
        //   "Crianza empoderada"    / "Empowered Parenting"    → EP
        //   "Hoja de ruta"          / "Roadmap to Resilience"  → RR
        // Display still uses the raw `name` (title); filter logic uses `group`.
        const title = r.activeTrackTitle.toLowerCase();
        let group = 'Other';
        if (title.includes('nurturing') || title.includes('crianza con')) group = 'NPP';
        else if (title.includes('empowered') || title.includes('crianza empoderada') || title.includes('empoderada')) group = 'EP';
        else if (title.includes('roadmap') || title.includes('resilience') || title.includes('hoja de ruta') || title.includes('resiliencia')) group = 'RR';
        inProgressTrack = {
          name: r.activeTrackTitle,
          group,
          sessionsDone,
          sessionsTotal,
          stalled,
          stalledDays,
        };
      }

      return {
        id: r.id,
        name: fullName,
        status: r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : 'Unknown',
        coordinatorId: r.coordinatorId || null,
        coordinator: coordFullName || null,
        phone: r.phone || null,
        email: r.email || null,
        affiliateId: r.affiliateId || null,
        affiliateName: r.affiliateName || null,
        intakeDate: r.intakeDate || null,
        inactiveDate: r.status === 'inactive' ? r.momUpdatedAt || null : null,
        lastContactDate: r.lastSessionDate || null,
        lastFwaDate: r.lastFwaDate || null,
        inProgressTrack,
        contactLog: contactLogByMom[r.id] || [],
      };
    });

    res.json(moms);
  } catch (err) {
    console.error('Error fetching mom-status:', err);
    res.status(500).json({ error: 'Failed to fetch mom status' });
  }
});

module.exports = router;
