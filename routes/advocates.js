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
    const isOrgWide = role === 'administrator' || (role === 'champion' && !user.affiliateId);

    if (role === 'coordinator') {
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

    // Fetch pairings for all returned advocates in one query
    const pairingsQuery = `
      SELECT
        p."advocateUserId",
        m."first_name" AS "momFirstName",
        m."last_name" AS "momLastName",
        p."status"::text AS "status",
        t."title" AS "trackTitle"
      FROM "Pairing" p
      LEFT JOIN "Mom" m ON m."id" = p."momId"
      LEFT JOIN "Track" t ON t."id" = p."trackId"
      WHERE p."advocateUserId" = ANY($1)
        AND p."deleted_at" = '0'
      ORDER BY p."advocateUserId", p."status"::text ASC
    `;
    const pairingsResult = await pool.query(pairingsQuery, [advocateIds]);

    // Fetch AdvocacyGroup assignments for all returned advocates
    const groupsQuery = `
      SELECT ag."advocateId", ag."name" AS "groupName", ag."state"::text AS "status", ag."capacity"
      FROM "AdvocacyGroup" ag
      WHERE ag."advocateId" = ANY($1) AND ag."deleted_at" = 0
    `;
    const groupsResult = await pool.query(groupsQuery, [advocateIds]);

    // Group pairings by advocate ID
    const pairingsByAdvocate = {};
    for (const p of pairingsResult.rows) {
      if (!pairingsByAdvocate[p.advocateUserId]) {
        pairingsByAdvocate[p.advocateUserId] = [];
      }
      pairingsByAdvocate[p.advocateUserId].push({
        momName: `${p.momFirstName || ''} ${p.momLastName || ''}`.trim(),
        status: p.status,
        trackTitle: p.trackTitle || null,
      });
    }

    // Merge group results into pairings
    for (const g of groupsResult.rows) {
      if (!pairingsByAdvocate[g.advocateId]) {
        pairingsByAdvocate[g.advocateId] = [];
      }
      pairingsByAdvocate[g.advocateId].push({
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
        totalGroups: r.totalGroups,
        activeGroups: r.activeGroups,
        latestNoteDate: r.latestNoteDate || null,
        latestNote: r.latestNote || null,
        pairings: pairingsByAdvocate[r.id] || [],
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
