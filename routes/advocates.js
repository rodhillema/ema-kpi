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
    ];
    const params = [];
    let paramIdx = 1;

    if (role === 'coordinator') {
      // Coordinator sees only their own advocates via the join table
      conditions.push(`atc."B" = $${paramIdx}`);
      params.push(user.id);
      paramIdx++;
    } else if (role === 'staff_advocate') {
      // Staff advocate is affiliate-scoped
      conditions.push(`u."affiliateId" = $${paramIdx}`);
      params.push(user.affiliate_id);
      paramIdx++;
    } else if (role === 'administrator' || role === 'supervisor') {
      // Optional affiliate filter via query param
      if (req.query.affiliate_id) {
        conditions.push(`u."affiliateId" = $${paramIdx}`);
        params.push(req.query.affiliate_id);
        paramIdx++;
      }
    }

    const whereClause = conditions.join(' AND ');

    const mainQuery = `
      SELECT
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
        coord."firstName" AS "coordFirstName",
        coord."lastName" AS "coordLastName",
        (SELECT COUNT(*)::int FROM "Pairing" p WHERE p."advocateUserId" = u."id" AND p."deleted_at" = '0') AS "totalPairings",
        (SELECT COUNT(*)::int FROM "Pairing" p WHERE p."advocateUserId" = u."id" AND p."status"::text = 'paired' AND p."deleted_at" = '0') AS "activePairings",
        ln."latestNoteDate",
        ln."latestNote"
      FROM "User" u
      LEFT JOIN "_AdvocateToCoordinator" atc ON atc."A" = u."id"
      LEFT JOIN "User" coord ON coord."id" = atc."B"
      LEFT JOIN LATERAL (
        SELECT cn."created_at" AS "latestNoteDate", cn."description" AS "latestNote"
        FROM "CoordinatorNote" cn
        WHERE cn."advocate_id" = u."id" AND cn."deleted_at" = '0'
        ORDER BY cn."created_at" DESC
        LIMIT 1
      ) ln ON true
      WHERE ${whereClause}
      ORDER BY u."lastName" ASC, u."firstName" ASC
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
        m."firstName" AS "momFirstName",
        m."lastName" AS "momLastName",
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

      return {
        id: r.id,
        name: `${firstName} ${lastName}`.trim(),
        initials,
        status: r.status,
        subStatus: r.subStatus,
        birthday: r.date_of_birth || null,
        email: r.email || null,
        phone: r.phone || null,
        coordinator: r.coordFirstName
          ? `${r.coordFirstName} ${r.coordLastName || ''}`.trim()
          : null,
        monthsActive,
        totalPairings: r.totalPairings,
        activePairings: r.activePairings,
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
