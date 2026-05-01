const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// All advocate routes require auth + coordinator-or-above role
router.use(requireAuth, requireRole);

// GET /api/advocates — list advocates with profile, coordinator, pairing counts, latest note
router.get('/', async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role;

    // Block champion role explicitly
    if (role === 'champion') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build WHERE clause based on role
    const conditions = [
      'u."advocate_status" IS NOT NULL',
      'u."deleted_at" = 0',
      // Exclude staff: users who have coordinator, supervisor, staff_advocate, or administrator roles
      `NOT EXISTS (
        SELECT 1 FROM "UserRole" ur2
        JOIN "Role" r2 ON r2."id" = ur2."role_id"
        WHERE ur2."user_id" = u."id" AND ur2."deleted_at" = 0
          AND r2."key" IN ('coordinator', 'supervisor', 'staff_advocate', 'administrator')
      )`,
    ];
    const params = [];
    let paramIdx = 1;

    // Determine if this user is org-wide
    const ORG_WIDE_USERNAMES = ['cristina.galloway'];
    const isOrgWide = role === 'administrator' || (role === 'champion' && !user.affiliateId) || ORG_WIDE_USERNAMES.includes((user.username || '').toLowerCase());

    if (!isOrgWide && role === 'coordinator') {
      // Coordinator sees advocates they've written notes about
      conditions.push(`EXISTS (SELECT 1 FROM "CoordinatorNote" cn WHERE cn."advocate_id" = u."id" AND cn."coordinator_id" = $${paramIdx} AND cn."deleted_at" = 0)`);
      params.push(user.id);
      paramIdx++;
    } else if (role === 'supervisor' || role === 'staff_advocate') {
      // Supervisor and staff_advocate are affiliate-scoped
      conditions.push(`u."affiliateId" = $${paramIdx}`);
      params.push(user.affiliateId);
      paramIdx++;
    } else if (isOrgWide) {
      // Administrator and org-wide champions — optional filter or exclude
      if (req.query.exclude_affiliate_id) {
        conditions.push(`u."affiliateId" != $${paramIdx}`);
        params.push(req.query.exclude_affiliate_id);
        paramIdx++;
      } else if (req.query.affiliate_id) {
        conditions.push(`u."affiliateId" = $${paramIdx}`);
        params.push(req.query.affiliate_id);
        paramIdx++;
      }
    } else {
      // Affiliate-scoped champion
      conditions.push(`u."affiliateId" = $${paramIdx}`);
      params.push(user.affiliateId);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const mainQuery = `
      SELECT DISTINCT ON (u."id")
        u."id",
        u."firstName",
        u."lastName",
        u."email",
        u."phone",
        u."date_of_birth",
        u."advocate_status"::text AS "status",
        u."advocate_sub_status"::text AS "subStatus",
        u."created_at",
        u."updated_at",
        u."affiliateId",
        lnc."coordFirstName",
        lnc."coordLastName",
        (SELECT COUNT(*)::int FROM "Pairing" p WHERE p."advocateUserId" = u."id" AND p."deleted_at" = 0) AS "totalPairings",
        (SELECT COUNT(*)::int FROM "Pairing" p WHERE p."advocateUserId" = u."id" AND p."status"::text = 'paired' AND p."deleted_at" = 0) AS "activePairings",
        (SELECT COUNT(*)::int FROM "AdvocacyGroup" ag WHERE ag."advocateId" = u."id" AND ag."deleted_at" = 0) AS "totalGroups",
        (SELECT COUNT(*)::int FROM "AdvocacyGroup" ag WHERE ag."advocateId" = u."id" AND ag."state"::text = 'active' AND ag."deleted_at" = 0) AS "activeGroups",
        lnc."latestNoteDate",
        lnc."latestNote"
      FROM "User" u
      LEFT JOIN LATERAL (
        SELECT cn."created_at" AS "latestNoteDate",
               cn."description" AS "latestNote",
               coord."firstName" AS "coordFirstName",
               coord."lastName" AS "coordLastName"
        FROM "CoordinatorNote" cn
        LEFT JOIN "User" coord ON coord."id" = cn."coordinator_id"
        WHERE cn."advocate_id" = u."id" AND cn."deleted_at" = 0
        ORDER BY cn."created_at" DESC
        LIMIT 1
      ) lnc ON true
      WHERE ${whereClause}
      ORDER BY u."id", u."lastName" ASC, u."firstName" ASC
    `;

    const { rows } = await pool.query(mainQuery, params);

    if (rows.length === 0) {
      return res.json([]);
    }

    // Collect advocate IDs for pairing sub-query
    const advocateIds = rows.map(r => r.id);

    // Fetch pairings for all returned advocates in one query.
    // Includes last-held-session date per pairing so we can compute the "stalled" flag.
    const pairingsQuery = `
      SELECT
        p."id" AS "pairingId",
        p."advocateUserId",
        m."first_name" AS "momFirstName",
        m."last_name" AS "momLastName",
        p."status"::text AS "status",
        t."title" AS "trackTitle",
        p."created_at" AS "startDate",
        p."completed_on" AS "endDate",
        (
          SELECT MAX(s."date_start") FROM "Session" s
          WHERE s."pairing_id" = p."id"
            AND s."deleted_at" = 0
            AND s."status"::text = 'Held'
        ) AS "lastHeldSessionAt"
      FROM "Pairing" p
      LEFT JOIN "Mom" m ON m."id" = p."momId"
      LEFT JOIN "Track" t ON t."id" = p."trackId"
      WHERE p."advocateUserId" = ANY($1)
        AND p."deleted_at" = 0
      ORDER BY p."advocateUserId", p."created_at" DESC
    `;
    const pairingsResult = await pool.query(pairingsQuery, [advocateIds]);

    // Fetch AdvocacyGroup assignments for all returned advocates.
    // Includes member_count for the group-pairing display Cristina added.
    const groupsQuery = `
      SELECT ag."id" AS "groupId",
        ag."advocateId",
        ag."name" AS "groupName",
        ag."state"::text AS "status",
        ag."capacity",
        ag."start_date" AS "startDate",
        ag."completed_date" AS "endDate",
        (
          SELECT COUNT(*)::int FROM "Pairing" p2
          WHERE p2."advocacyGroupId" = ag."id"
            AND p2."deleted_at" = 0
        ) AS "memberCount"
      FROM "AdvocacyGroup" ag
      WHERE ag."advocateId" = ANY($1) AND ag."deleted_at" = 0
    `;
    let groupsResult;
    try {
      groupsResult = await pool.query(groupsQuery, [advocateIds]);
    } catch (e) {
      // Fallback if Pairing.advocacyGroupId column doesn't exist yet on this deploy —
      // return groups without member counts.
      console.warn('[api/advocates] AdvocacyGroup member-count join failed; returning groups without memberCount:', e.message);
      groupsResult = await pool.query(`
        SELECT ag."id" AS "groupId", ag."advocateId", ag."name" AS "groupName",
          ag."state"::text AS "status", ag."capacity",
          ag."start_date" AS "startDate", ag."completed_date" AS "endDate",
          NULL::int AS "memberCount"
        FROM "AdvocacyGroup" ag
        WHERE ag."advocateId" = ANY($1) AND ag."deleted_at" = 0
      `, [advocateIds]);
    }

    // Contact log — last 5 entries per advocate, blending their Sessions and CoordinatorNotes.
    // Sessions come from any pairing this advocate has.
    // CoordinatorNotes are the coordinator's notes about this advocate.
    const contactLogQuery = `
      WITH combined AS (
        SELECT p."advocateUserId" AS advocate_id,
          s."date_start" AS log_date,
          s."status"::text AS log_type,
          NULL::text AS note_text,
          coord."firstName" AS author_first,
          coord."lastName" AS author_last,
          m."first_name" AS mom_first,
          m."last_name" AS mom_last,
          'session' AS source_kind
        FROM "Session" s
        JOIN "Pairing" p ON p."id" = s."pairing_id"
        LEFT JOIN "Mom" m ON m."id" = p."momId"
        LEFT JOIN "User" coord ON coord."id" = s."created_by_id"
        WHERE p."advocateUserId" = ANY($1)
          AND s."deleted_at" = 0
        UNION ALL
        SELECT cn."advocate_id" AS advocate_id,
          cn."created_at" AS log_date,
          'Coordinator note' AS log_type,
          cn."description" AS note_text,
          coord."firstName" AS author_first,
          coord."lastName" AS author_last,
          NULL AS mom_first,
          NULL AS mom_last,
          'note' AS source_kind
        FROM "CoordinatorNote" cn
        LEFT JOIN "User" coord ON coord."id" = cn."coordinator_id"
        WHERE cn."advocate_id" = ANY($1)
          AND cn."deleted_at" = 0
      ),
      ranked AS (
        SELECT advocate_id, log_date, log_type, note_text, author_first, author_last,
          mom_first, mom_last, source_kind,
          ROW_NUMBER() OVER (PARTITION BY advocate_id ORDER BY log_date DESC) AS rn
        FROM combined
      )
      SELECT advocate_id, log_date, log_type, note_text, author_first, author_last,
        mom_first, mom_last, source_kind
      FROM ranked
      WHERE rn <= 5
      ORDER BY advocate_id, log_date DESC
    `;
    let contactLogResult;
    try {
      contactLogResult = await pool.query(contactLogQuery, [advocateIds]);
    } catch (e) {
      // Fallback if Session.created_by_id doesn't exist on this deploy — return empty log.
      console.warn('[api/advocates] Contact log query failed; returning empty contactLog:', e.message);
      contactLogResult = { rows: [] };
    }
    const contactLogByAdvocate = {};
    for (const r of contactLogResult.rows) {
      if (!contactLogByAdvocate[r.advocate_id]) contactLogByAdvocate[r.advocate_id] = [];
      const author = r.author_first
        ? `${r.author_first} ${r.author_last || ''}`.trim()
        : null;
      const momName = r.mom_first
        ? `${r.mom_first} ${r.mom_last || ''}`.trim()
        : null;
      contactLogByAdvocate[r.advocate_id].push({
        date: r.log_date,
        type: r.log_type,
        author,
        momName,
        note: r.note_text || null,
      });
    }

    // Group pairings by advocate ID
    const pairingsByAdvocate = {};
    // Format dates as "MMM D, YYYY"
    function fmtDate(d) {
      if (!d) return '—';
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return '—';
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    // Map pairing status → outcome label
    function mapOutcome(status) {
      if (status === 'paired') return 'active';
      if (status === 'pairing_complete') return 'Completed';
      if (status === 'waiting_to_be_paired') return 'Waiting';
      return status || '—';
    }

    // Compute "stalled" for each active pairing — last held session > 14 days ago.
    function daysSince(d) {
      if (!d) return null;
      const then = new Date(d);
      if (Number.isNaN(then.getTime())) return null;
      return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24));
    }

    for (const p of pairingsResult.rows) {
      if (!pairingsByAdvocate[p.advocateUserId]) {
        pairingsByAdvocate[p.advocateUserId] = [];
      }
      const outcome = mapOutcome(p.status);
      const isActive = outcome === 'active';
      const daysSinceHeld = daysSince(p.lastHeldSessionAt);
      const stalled = isActive && daysSinceHeld != null && daysSinceHeld > 14;
      pairingsByAdvocate[p.advocateUserId].push({
        mom: `${p.momFirstName || ''} ${p.momLastName || ''}`.trim() || 'Unknown',
        type: p.trackTitle || '1:1',
        start: fmtDate(p.startDate),
        end: p.endDate ? fmtDate(p.endDate) : 'ongoing',
        outcome,
        stalled,
        // Keep original for back-compat
        momName: `${p.momFirstName || ''} ${p.momLastName || ''}`.trim(),
        status: p.status,
        trackTitle: p.trackTitle || null,
      });
    }

    // Merge group results into pairings.
    // Cristina's new file reads `p.groupName` + `p.memberCount` for group rows.
    for (const g of groupsResult.rows) {
      if (!pairingsByAdvocate[g.advocateId]) {
        pairingsByAdvocate[g.advocateId] = [];
      }
      const isActive = g.status === 'active';
      pairingsByAdvocate[g.advocateId].push({
        mom: g.groupName || 'Group',
        type: 'Group',
        groupName: g.groupName || 'Group',
        memberCount: g.memberCount || null,
        start: fmtDate(g.startDate),
        end: g.endDate ? fmtDate(g.endDate) : 'ongoing',
        outcome: isActive ? 'active' : (g.status === 'completed' ? 'Completed' : g.status),
        stalled: false, // group stall detection not yet modeled
        momName: g.groupName,
        status: g.status,
        trackTitle: 'Group',
        isGroup: true,
      });
    }

    // Shape response
    const now = new Date();
    const advocates = rows.map(r => {
      const createdAt = r.created_at ? new Date(
        typeof r.created_at === 'number' || /^\d+$/.test(r.created_at)
          ? Number(r.created_at)
          : r.created_at
      ) : null;

      let monthsActive = 0;
      if (createdAt && !isNaN(createdAt.getTime())) {
        monthsActive = (now.getFullYear() - createdAt.getFullYear()) * 12
          + (now.getMonth() - createdAt.getMonth());
        if (monthsActive < 0) monthsActive = 0;
      }

      const firstName = r.firstName || '';
      const lastName = r.lastName || '';
      const initials = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();

      // Correct sub-status mismatches
      // Format enum values: "Did_Not_Onboard" → "Did Not Onboard"
      function fmtEnum(val) {
        if (!val) return '';
        return val.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      const status = fmtEnum(r.status);
      const subStatus = fmtEnum(r.subStatus);
      const activePairings = r.activePairings;
      const activeGroups = r.activeGroups;
      let correctedSubStatus = subStatus;
      let mismatch = false;
      if (status === 'Active' && subStatus === 'Paired') {
        if (activePairings === 0 && activeGroups === 0) {
          correctedSubStatus = 'Waiting To Be Paired';
          mismatch = true;
        }
      }
      if (status === 'Active' && (subStatus === 'Waiting To Be Paired' || subStatus === 'Waiting_To_Be_Paired')) {
        if (activePairings > 0 || activeGroups > 0) {
          correctedSubStatus = 'Paired';
          mismatch = true;
        }
      }

      return {
        id: r.id,
        name: `${firstName} ${lastName}`.trim(),
        initials,
        status: status,
        subStatus: correctedSubStatus,
        sub: correctedSubStatus,  // frontend uses 'sub' field name
        mismatchFlag: mismatch,
        birthday: r.date_of_birth || null,
        email: r.email || null,
        phone: r.phone || null,
        coordinator: r.coordFirstName
          ? `${r.coordFirstName} ${r.coordLastName || ''}`.trim()
          : null,
        monthsActive,
        totalPairings: r.totalPairings,
        activePairings: r.activePairings,
        // Alias Cristina's new file reads — same value as activeGroups. Keep activeGroups for back-compat.
        activeGroupFacilitations: r.activeGroups,
        totalGroups: r.totalGroups,
        activeGroups: r.activeGroups,
        // Proxy for "when did this advocate enter current sub-status" — User.updated_at.
        // Accurate when the most recent update was a status change; imprecise if other fields
        // (name, email, etc.) were edited more recently. Event-based tracking via AuditLog would
        // be more accurate but the JSON shape is currently undiagnosable (see CLAUDE.md gap).
        subStatusSince: r.updated_at || null,
        latestNoteDate: r.latestNoteDate || null,
        latestNote: r.latestNote || null,
        pairings: pairingsByAdvocate[r.id] || [],
        contactLog: contactLogByAdvocate[r.id] || [],
      };
    });

    res.json(advocates);
  } catch (err) {
    console.error('Error fetching advocates:', err);
    res.status(500).json({ error: 'Failed to fetch advocates' });
  }
});

// POST /api/advocates/export-audit — HIPAA audit log for advocate data exports
router.post('/export-audit', async (req, res) => {
  const { timestamp, recordCount, recordIds, filters } = req.body;
  const user = req.session.user;
  console.log(`[EXPORT-AUDIT] ${user.username} (${user.role}) exported ${recordCount} advocate records at ${timestamp}`);
  console.log(`[EXPORT-AUDIT] Filters: ${JSON.stringify(filters)}`);
  console.log(`[EXPORT-AUDIT] Record IDs: ${JSON.stringify(recordIds)}`);
  res.json({ success: true });
});

module.exports = router;
