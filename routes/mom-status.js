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

    if (isOrgWide) {
      // Org-wide users — optional filter via query param
      if (req.query.exclude_affiliate_id) {
        conditions.push(`m."affiliate_id" != $${paramIdx}`);
        params.push(req.query.exclude_affiliate_id);
        paramIdx++;
      } else if (req.query.affiliate_id) {
        conditions.push(`m."affiliate_id" = $${paramIdx}`);
        params.push(req.query.affiliate_id);
        paramIdx++;
      }
    } else if (role === 'coordinator' || role === 'supervisor' || role === 'staff_advocate') {
      // Affiliate-scoped staff roles
      conditions.push(`m."affiliate_id" = $${paramIdx}`);
      params.push(user.affiliateId);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Main query — one row per mom with core profile + coordinator + latest FWA + current pairing.
    // DISTINCT ON prevents duplicate rows when a mom has multiple pairings / coordinator assignments.
    const mainQuery = `
      WITH coord_for_mom AS (
        -- Coordinator always comes from the mom's Pairing record (via advocate link).
        -- Rule (Fix 7): never use AdvocacyGroup.coordinator — always source from Pairing.
        -- Priority: (1) active pairing over completed, (2) 1:1 over group, (3) most recent note.
        -- Tiebreaker: if a mom has both a 1:1 and a group pairing, the 1:1 coordinator wins.
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          cn."coordinator_id" AS coordinator_id,
          coord."firstName" AS coord_first,
          coord."lastName"  AS coord_last
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        LEFT JOIN "User" coord ON coord."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0
        ORDER BY p."momId",
          (p."status"::text <> 'paired') ASC,       -- active pairings first
          (p."advocacy_type"::text = 'group') ASC,   -- 1:1 before group within same tier
          cn."created_at" DESC                        -- most recent note as last-resort tiebreak
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
          t."title" AS track_title,
          p."advocacy_type"::text AS pairing_type
        FROM "Pairing" p
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        WHERE p."deleted_at" = 0
          AND p."status"::text = 'paired'
        ORDER BY p."momId", p."created_at" DESC
      ),
      latest_session AS (
        -- Latest HELD session per mom — source for communication stall (Fix 8).
        -- Held-only: Planned/NotHeld sessions are not actual contact.
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          s."date_start" AS session_date,
          s."status"::text AS session_status
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        WHERE s."deleted_at" = 0
          AND s."status"::text = 'Held'
        ORDER BY p."momId", s."date_start" DESC
      ),
      last_curriculum_session AS (
        -- Latest held session with lesson content (lesson_template_id IS NOT NULL).
        -- Source for curriculum stall threshold (30 days, Fix 8).
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          s."date_start" AS curriculum_date
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        WHERE s."deleted_at" = 0
          AND s."status"::text = 'Held'
          AND s."lesson_template_id" IS NOT NULL
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
        ap.pairing_type AS "activePairingType",
        ls.session_date AS "lastSessionDate",
        ls.session_status AS "lastSessionStatus",
        lcs.curriculum_date AS "lastCurriculumDate",
        COALESCE(lfwa.fwa_date, ife.engaged_date) AS "intakeDate",
        m."updated_at" AS "momUpdatedAt"
      FROM "Mom" m
      LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
      LEFT JOIN coord_for_mom cfm ON cfm.mom_id = m."id"
      LEFT JOIN latest_fwa lfwa ON lfwa.mom_id = m."id"
      LEFT JOIN active_pairing ap ON ap.mom_id = m."id"
      LEFT JOIN latest_session ls ON ls.mom_id = m."id"
      LEFT JOIN last_curriculum_session lcs ON lcs.mom_id = m."id"
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

    // Track history — all non-deleted pairings per mom (current + past).
    // Wrapped in try/catch so any schema issue here doesn't blank the whole
    // response. Outcome derived: 'active' = still paired, 'completed' =
    // complete_reason set, 'incomplete' = incomplete_reason set.
    const trackHistoryByMom = {};
    try {
      const trackHistoryQuery = `
        SELECT
          p."momId"                                  AS mom_id,
          p."id"                                     AS pairing_id,
          t."title"                                  AS track_title,
          p."status"::text                           AS status,
          p."advocacy_type"::text                    AS advocacy_type,
          p."created_at"                             AS started_at,
          p."completed_on"                           AS ended_at,
          p."complete_reason_sub_status"::text       AS complete_reason,
          p."incomplete_reason_sub_status"::text     AS incomplete_reason,
          adv."firstName"                            AS adv_first,
          adv."lastName"                             AS adv_last
        FROM "Pairing" p
        LEFT JOIN "Track" t ON t."id" = p."trackId"
        LEFT JOIN "User"  adv ON adv."id" = p."advocateUserId"
        WHERE p."momId" = ANY($1)
          AND p."deleted_at" = 0
        ORDER BY p."momId", p."created_at" DESC
      `;
      const trackHistoryResult = await pool.query(trackHistoryQuery, [momIds]);
      for (const r of trackHistoryResult.rows) {
        if (!trackHistoryByMom[r.mom_id]) trackHistoryByMom[r.mom_id] = [];
        let outcome = 'unknown';
        if (r.status === 'paired') outcome = 'active';
        else if (r.complete_reason)   outcome = 'completed';
        else if (r.incomplete_reason) outcome = 'incomplete';
        const advName = [r.adv_first, r.adv_last].filter(Boolean).join(' ').trim();
        trackHistoryByMom[r.mom_id].push({
          pairingId:    r.pairing_id,
          name:         r.track_title || '—',
          start:        r.started_at,
          end:          r.ended_at,
          outcome,
          completeReason:   r.complete_reason || null,
          incompleteReason: r.incomplete_reason || null,
          pairingType:  r.advocacy_type === 'group' ? 'group' : '1:1',
          advocateName: advName || null,
        });
      }
    } catch (err) {
      console.error('[mom-status] trackHistory query failed:', err.message);
      // Continue without track history rather than failing the whole endpoint.
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
        const curriculumDays = daysSince(r.lastCurriculumDate);
        const commStall = stalledDays == null || stalledDays > 14;
        const currStall = curriculumDays == null || curriculumDays > 30;
        const stall_type = (commStall && currStall) ? 'both'
                         : commStall ? 'communication'
                         : currStall ? 'curriculum'
                         : null;
        const stalled = stall_type !== null;
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
          pairingType: r.activePairingType === 'group' ? 'group' : '1:1',
          sessionsDone,
          sessionsTotal,
          stalled,
          stall_type,
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
        trackHistory: trackHistoryByMom[r.id] || [],
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
