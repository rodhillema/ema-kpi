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
      WITH coord_candidates AS (
        -- Per-mom coordinator resolution.
        --
        -- Priority 0: Mom.assigned_user_id — this is the direct Trellis
        -- "Assigned Coordinator" field, the authoritative source for both
        -- 1:1 and group pairings. Confirmed: Elbony Ingram's assigned_user_id
        -- = Babie-Marie Henriquez, matching Trellis. Use this first.
        --
        -- Priorities 1-4: _AdvocateToCoordinator fallback (A=coord, B=advocate).
        -- Priorities 5-10: CoordinatorNote fallback (history, last resort).
        --
        -- Priority chain (lowest wins):
        --   0  Mom.assigned_user_id (direct Trellis assignment)
        --   1  active 1:1 pairing  → _AdvocateToCoordinator via advocateUserId
        --   2  active group pairing → _AdvocateToCoordinator via AG.advocateId
        --   3  completed 1:1 pairing → _AdvocateToCoordinator via advocateUserId
        --   4  completed group pairing → _AdvocateToCoordinator via AG.advocateId
        --   5  direct mom-linked CoordinatorNote (cn.mom_id = mom.id)
        --   6  active 1:1 pairing  → CN via advocateUserId
        --   7  active group pairing → CN via facilitator (AG.advocateId)
        --   8  completed 1:1 pairing → CN via advocateUserId
        --   9  completed group pairing → CN via facilitator
        SELECT m."id" AS mom_id, m."assigned_user_id" AS coordinator_id,
               u."firstName" AS coord_first, u."lastName" AS coord_last,
               0 AS priority, m."updated_at" AS sort_date
        FROM "Mom" m
        JOIN "User" u ON u."id" = m."assigned_user_id"
        WHERE m."assigned_user_id" IS NOT NULL
        UNION ALL
        SELECT p."momId" AS mom_id, atc."A" AS coordinator_id,
               c."firstName" AS coord_first, c."lastName" AS coord_last,
               1 AS priority, p."created_at" AS sort_date
        FROM "Pairing" p
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = p."advocateUserId"
        JOIN "User" c ON c."id" = atc."A"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               c."firstName", c."lastName",
               2, p."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = ag."advocateId"
        JOIN "User" c ON c."id" = atc."A"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               c."firstName", c."lastName",
               3, p."created_at"
        FROM "Pairing" p
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = p."advocateUserId"
        JOIN "User" c ON c."id" = atc."A"
        WHERE p."deleted_at" = 0 AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", atc."A",
               c."firstName", c."lastName",
               4, p."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "_AdvocateToCoordinator" atc ON atc."B" = ag."advocateId"
        JOIN "User" c ON c."id" = atc."A"
        WHERE p."deleted_at" = 0 AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT cn."mom_id" AS mom_id, cn."coordinator_id",
               c."firstName", c."lastName",
               5, cn."created_at"
        FROM "CoordinatorNote" cn
        JOIN "User" c ON c."id" = cn."coordinator_id"
        WHERE cn."mom_id" IS NOT NULL AND cn."deleted_at" = 0
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               c."firstName", c."lastName",
               6, cn."created_at"
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        JOIN "User" c ON c."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               c."firstName", c."lastName",
               7, cn."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = ag."advocateId" AND cn."deleted_at" = 0
        JOIN "User" c ON c."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0 AND p."status"::text = 'paired'
          AND p."advocacy_type"::text = 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               c."firstName", c."lastName",
               8, cn."created_at"
        FROM "Pairing" p
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = p."advocateUserId" AND cn."deleted_at" = 0
        JOIN "User" c ON c."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0 AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text <> 'group'
        UNION ALL
        SELECT p."momId", cn."coordinator_id",
               c."firstName", c."lastName",
               9, cn."created_at"
        FROM "Pairing" p
        JOIN "AdvocacyGroup" ag ON ag."id" = p."advocacyGroupId"
        JOIN "CoordinatorNote" cn ON cn."advocate_id" = ag."advocateId" AND cn."deleted_at" = 0
        JOIN "User" c ON c."id" = cn."coordinator_id"
        WHERE p."deleted_at" = 0 AND p."status"::text <> 'paired'
          AND p."advocacy_type"::text = 'group'
      ),
      coord_for_mom AS (
        SELECT DISTINCT ON (mom_id)
          mom_id, coordinator_id, coord_first, coord_last
        FROM coord_candidates
        ORDER BY mom_id, priority ASC, sort_date DESC NULLS LAST
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
        -- Latest session note per mom — date_submitted_c is the true completion date.
        -- Uses Session.mom_id to cover both 1:1 and group pairings. Captures lessons
        -- marked complete via SessionNote even when Session.status stays 'Planned'.
        SELECT DISTINCT ON (s."mom_id")
          s."mom_id" AS mom_id,
          sn."date_submitted_c" AS session_date,
          'Complete'::text AS session_status
        FROM "SessionNote" sn
        JOIN "Session" s ON s."id" = sn."session_id"
          AND s."deleted_at" = 0
          AND s."mom_id" IS NOT NULL
        WHERE sn."deleted_at" = 0
          AND sn."date_submitted_c" IS NOT NULL
        ORDER BY s."mom_id", sn."date_submitted_c" DESC NULLS LAST
      ),
      last_curriculum_session AS (
        -- Latest SessionNote that covered a completed Lesson — true curriculum date.
        -- Session.status may say 'Planned' but Lesson.status='completed' confirms the lesson was done.
        SELECT DISTINCT ON (p."momId")
          p."momId" AS mom_id,
          sn."date_submitted_c" AS curriculum_date
        FROM "SessionNote" sn
        JOIN "Session" s ON s."id" = sn."session_id"
          AND s."deleted_at" = 0
        JOIN "Lesson" l ON l."id" = sn."covered_lesson_id"
          AND l."status"::text = 'completed'
        JOIN "Pairing" p ON p."id" = l."pairing_id"
          AND p."deleted_at" = 0
        WHERE sn."deleted_at" = 0
          AND sn."covered_lesson_id" IS NOT NULL
        ORDER BY p."momId", sn."date_submitted_c" DESC NULLS LAST
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
        m."children_in_home" AS "childrenInHome",
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
        lfwa.fwa_date AS "intakeDate",
        m."updated_at" AS "momUpdatedAt"
      FROM "Mom" m
      LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
      LEFT JOIN coord_for_mom cfm ON cfm.mom_id = m."id"
      LEFT JOIN latest_fwa lfwa ON lfwa.mom_id = m."id"
      LEFT JOIN active_pairing ap ON ap.mom_id = m."id"
      LEFT JOIN latest_session ls ON ls.mom_id = m."id"
      LEFT JOIN last_curriculum_session lcs ON lcs.mom_id = m."id"
      WHERE ${whereClause}
      ORDER BY m."last_name" ASC NULLS LAST, m."first_name" ASC NULLS LAST
    `;

    const { rows } = await pool.query(mainQuery, params);

    if (rows.length === 0) {
      return res.json([]);
    }

    const momIds = rows.map((r) => r.id);

    // Lesson completion count per active pairing — Lesson.status='completed' is the
    // authoritative source, matching what Trellis shows in its lesson tracker.
    // Replaces the prior Session.status='Held' approach which missed lessons marked
    // complete via SessionNote without Session.status being updated.
    const sessionsQuery = `
      SELECT p."momId" AS mom_id,
             COUNT(l."id")::int AS held_sessions
      FROM "Pairing" p
      LEFT JOIN "Lesson" l ON l."pairing_id" = p."id"
        AND l."status"::text = 'completed'
      WHERE p."momId" = ANY($1)
        AND p."deleted_at" = 0
        AND p."status"::text = 'paired'
      GROUP BY p."momId"
    `;
    let sessionsResult;
    try {
      sessionsResult = await pool.query(sessionsQuery, [momIds]);
    } catch (_err) {
      sessionsResult = { rows: [] };
    }
    const heldByMom = Object.fromEntries(sessionsResult.rows.map((r) => [r.mom_id, r.held_sessions]));

    // Support_Session held count per active pairing. A support session counts as held when
    // Session.status='Held'/'Unmarked' OR when a SessionNote with date_submitted_c exists
    // (Trellis treats the latter as held even when Session.status stays 'Planned').
    // Joins both pairing_id and advocacy_group_id to cover 1:1 and group delivery.
    const supportQuery = `
      SELECT p."momId" AS mom_id,
             COUNT(DISTINCT s."id")::int AS support_sessions
      FROM "Pairing" p
      JOIN "Session" s
        ON (
          s."pairing_id" = p."id"
          OR (p."advocacyGroupId" IS NOT NULL AND s."advocacy_group_id" = p."advocacyGroupId")
        )
        AND s."session_type"::text = 'Support_Session'
        AND s."deleted_at" = 0
        AND (
          s."status"::text IN ('Held', 'Unmarked')
          OR EXISTS (
            SELECT 1 FROM "SessionNote" sn
             WHERE sn."session_id" = s."id"
               AND sn."deleted_at" = 0
               AND sn."date_submitted_c" IS NOT NULL
          )
        )
      WHERE p."momId" = ANY($1)
        AND p."deleted_at" = 0
        AND p."status"::text = 'paired'
      GROUP BY p."momId"
    `;
    let supportResult;
    try {
      supportResult = await pool.query(supportQuery, [momIds]);
    } catch (_err) {
      supportResult = { rows: [] };
    }
    const supportByMom = Object.fromEntries(supportResult.rows.map((r) => [r.mom_id, r.support_sessions]));

    // Contact log — last 5 entries per mom: held/not-held sessions + mom-linked coordinator notes.
    // CoordinatorNotes are joined directly on cn.mom_id (not via advocate).
    const contactLogQuery = `
      WITH combined AS (
        SELECT p."momId" AS mom_id,
          s."date_start" AS log_date,
          s."status"::text AS log_type,
          NULL::text AS note_text
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        WHERE p."momId" = ANY($1)
          AND s."deleted_at" = 0
        UNION ALL
        SELECT cn."mom_id",
          cn."created_at" AS log_date,
          'Coordinator note' AS log_type,
          cn."description" AS note_text
        FROM "CoordinatorNote" cn
        WHERE cn."mom_id" = ANY($1)
          AND cn."deleted_at" = 0
      ),
      ranked AS (
        SELECT mom_id, log_date, log_type, note_text,
          ROW_NUMBER() OVER (PARTITION BY mom_id ORDER BY log_date DESC) AS rn
        FROM combined
      )
      SELECT mom_id, log_date, log_type, note_text
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

    // Connection logs — last 5 per mom from ConnectionLog (mom's direct contact record).
    const connectionLogsQuery = `
      WITH ranked AS (
        SELECT
          cl."mom_id",
          cl."date_created_c"     AS log_date,
          cl."summary_c"          AS summary,
          cl."contact_method_c"::text AS method,
          cl."created_by_name"    AS created_by,
          ROW_NUMBER() OVER (PARTITION BY cl."mom_id" ORDER BY cl."date_created_c" DESC) AS rn
        FROM "ConnectionLog" cl
        WHERE cl."mom_id" = ANY($1)
          AND cl."deleted_at" = 0
      )
      SELECT mom_id, log_date, summary, method, created_by
      FROM ranked
      WHERE rn <= 5
      ORDER BY mom_id, log_date DESC
    `;
    const connectionLogsResult = await pool.query(connectionLogsQuery, [momIds]);
    const connectionLogsByMom = {};
    for (const r of connectionLogsResult.rows) {
      if (!connectionLogsByMom[r.mom_id]) connectionLogsByMom[r.mom_id] = [];
      connectionLogsByMom[r.mom_id].push({
        date:      r.log_date,
        summary:   r.summary || null,
        method:    r.method  || null,
        createdBy: r.created_by || null,
      });
    }

    // Flagged needs — all non-deleted BenevolenceNeed records per mom.
    const flaggedNeedsQuery = `
      SELECT
        bn."momId"               AS mom_id,
        bn."id",
        bn."type_c"::text        AS need_type,
        bn."name",
        bn."description",
        bn."is_urgent_c"         AS urgent,
        bn."did_address_need_c"  AS addressed,
        bn."provided_date_c"     AS provided_date,
        bn."resolved_date_c"     AS resolved_date,
        bn."created_at"
      FROM "BenevolenceNeed" bn
      WHERE bn."momId" = ANY($1)
        AND bn."deleted_at" = 0
      ORDER BY bn."momId", bn."created_at" DESC
    `;
    const flaggedNeedsResult = await pool.query(flaggedNeedsQuery, [momIds]);
    const flaggedNeedsByMom = {};
    for (const r of flaggedNeedsResult.rows) {
      if (!flaggedNeedsByMom[r.mom_id]) flaggedNeedsByMom[r.mom_id] = [];
      let status = 'Open';
      if (r.resolved_date) status = 'Resolved';
      else if (r.addressed)  status = 'Fulfilled';
      flaggedNeedsByMom[r.mom_id].push({
        id:          r.id,
        needType:    r.need_type || r.name || 'Need',
        description: r.description || null,
        urgent:      !!r.urgent,
        status,
        requestedDate: r.created_at || null,
        resolvedDate:  r.resolved_date || null,
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
        LEFT JOIN "AdvocacyGroup" ag_pair ON ag_pair."id" = p."advocacyGroupId" AND ag_pair."deleted_at" = 0
        LEFT JOIN "User"  adv ON adv."id" = COALESCE(p."advocateUserId", ag_pair."advocateId")
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

    // Children — one row per Child record per mom, with current welfare involvement.
    // childrenInHome (from Mom.children_in_home) drives the drawer count; this list
    // drives the X-of-Y welfare denominator + the distinct welfare pills.
    // Enum values like "0_foster_care" / "5_kinship_placement" are stripped of the
    // leading sort prefix and title-cased server-side so the frontend renders clean labels.
    const childrenByMom = {};
    try {
      const childrenQuery = `
        SELECT
          c."id"                              AS child_id,
          c."mom_id"                          AS mom_id,
          c."active_child_welfare_involvement"::text AS cw_raw
        FROM "Child" c
        WHERE c."mom_id" = ANY($1)
          AND c."deleted_at" = 0
      `;
      const childrenResult = await pool.query(childrenQuery, [momIds]);
      const prettifyCw = (raw) => {
        if (!raw) return null;
        // "No Open Case" variants are not active welfare involvement — exclude them
        // so they don't appear as welfare pills or inflate the CW child count.
        // Raw values confirmed from DB: 0_permanently_removed, 30_custody_maintained.
        if (raw === '0_permanently_removed' || raw === '30_custody_maintained') return null;
        // Strip optional leading "N_" sort prefix, replace underscores, title-case.
        const stripped = raw.replace(/^\d+_/, '').replace(/_/g, ' ').trim();
        if (!stripped) return null;
        return stripped.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      };
      for (const r of childrenResult.rows) {
        if (!childrenByMom[r.mom_id]) childrenByMom[r.mom_id] = [];
        childrenByMom[r.mom_id].push({
          id: r.child_id,
          cwType: prettifyCw(r.cw_raw),
        });
      }
    } catch (err) {
      console.error('[mom-status] children query failed:', err.message);
      // Continue without children rather than failing the whole endpoint.
    }

    // Required-sessions lookup by track title — mirrors report-data.js REQUIRED_SESSIONS.
    const REQUIRED_SESSIONS = {
      // Historical names — kept for old pairing records
      'Nurturing Parenting Program': 10,
      'El programa de Crianza con cariño NPP': 10,
      'Empowered Parenting': 8,
      'Crianza empoderada EP': 8,
      'Roadmap to Resilience': 4,
      'Hoja de ruta hacia la resiliencia RR': 4,
      // Current names — CODE - Title format
      'NPP - Nurturing Parenting Program': 10,
      'NPP - El programa de Crianza con cariño': 10,
      'EP - Empowered Parenting': 8,
      'EP - Crianza empoderada': 8,
      'RR - Roadmap to Resilience': 4,
      'RR - Hoja de ruta hacia la resiliencia': 4,
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
        // Only stalled if a held session EXISTS and was >14 days ago.
        // Null (no session ever held) is NOT a stall — the clock hasn't started.
        const commStall = stalledDays != null && stalledDays > 14;
        const currStall = curriculumDays != null && curriculumDays > 30;
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
          supportSessions: supportByMom[r.id] || 0,
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
        childrenInHome: (r.childrenInHome == null ? null : Number(r.childrenInHome)),
        children: childrenByMom[r.id] || [],
        intakeDate: r.intakeDate || null,
        inactiveDate: r.status === 'inactive' ? r.momUpdatedAt || null : null,
        lastContactDate: r.lastSessionDate || (connectionLogsByMom[r.id]?.[0]?.date ?? null),
        lastFwaDate: r.lastFwaDate || null,
        inProgressTrack,
        trackHistory:    trackHistoryByMom[r.id]    || [],
        contactLog:      contactLogByMom[r.id]      || [],
        connectionLogs:  connectionLogsByMom[r.id]  || [],
        flaggedNeeds:    flaggedNeedsByMom[r.id]    || [],
      };
    });

    res.json(moms);
  } catch (err) {
    console.error('Error fetching mom-status:', err);
    res.status(500).json({ error: 'Failed to fetch mom status' });
  }
});

module.exports = router;
