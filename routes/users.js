/* ============================================================
   GET /api/users — RBAC-scoped Trellis user list
   Used by public/user-report.html (User Report, Trellis Live).

   Scope rules:
     administrator / org-wide → all non-deleted users, no role filter
     supervisor               → own affiliate, visible: Advocate + Coordinator + Staff Advocate
     staff_advocate           → own affiliate, visible: Advocate + Coordinator
     coordinator              → own affiliate, visible: Advocate
     champion (with aff)      → own affiliate, visible: Advocate
     champion (no aff)        → org-wide, visible: all (same as admin)
   ============================================================ */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole);

const VISIBLE_ROLES_BY_SESSION_ROLE = {
  coordinator:   ['Advocate'],
  staff_advocate:['Advocate', 'Coordinator'],
  supervisor:    ['Advocate', 'Coordinator', 'Staff Advocate'],
  administrator: null,   // unrestricted
  champion:      ['Advocate'],
};

const ORG_WIDE_USERNAMES = ['cristina.galloway'];

router.get('/', async (req, res) => {
  try {
    const user     = req.session.user;
    const role     = user.role;
    const isOrgWide =
      role === 'administrator' ||
      ORG_WIDE_USERNAMES.includes((user.username || '').toLowerCase()) ||
      (role === 'champion' && !user.affiliateId);

    const visibleRoles = isOrgWide
      ? null
      : (VISIBLE_ROLES_BY_SESSION_ROLE[role] || ['Advocate']);

    const conditions = [`u."deleted_at" = 0`];
    const params = [];
    let p = 1;

    if (!isOrgWide) {
      conditions.push(`u."affiliateId" = $${p++}`);
      params.push(user.affiliateId);

      // Only return users who have at least one of the viewer's visible roles
      conditions.push(`u."id" IN (
        SELECT ur2."user_id"
        FROM "UserRole" ur2
        JOIN "Role" r2 ON r2."id" = ur2."role_id"
        WHERE ur2."deleted_at" = '0'
          AND r2."name" = ANY($${p++})
      )`);
      params.push(visibleRoles);
    }

    const whereClause = conditions.join(' AND ');

    const [usersRes, affiliatesRes] = await Promise.all([
      pool.query(`
        SELECT
          u."id",
          u."firstName",
          u."lastName",
          u."username",
          u."email",
          u."status"::text                        AS status,
          u."affiliateId",
          COALESCE(a."name", '')                  AS "affiliateName",
          STRING_AGG(r."name", ', ' ORDER BY r."name") AS roles
        FROM "User" u
        LEFT JOIN "Affiliate" a ON a."id" = u."affiliateId"
        JOIN "UserRole" ur ON ur."user_id" = u."id" AND ur."deleted_at" = '0'
        JOIN "Role" r ON r."id" = ur."role_id"
        WHERE ${whereClause}
        GROUP BY
          u."id", u."firstName", u."lastName", u."username",
          u."email", u."status", u."affiliateId", a."name"
        ORDER BY u."lastName", u."firstName"
      `, params),
      pool.query(
        `SELECT "id", "name" FROM "Affiliate" WHERE "deleted_at" = 0 ORDER BY "name"`
      ),
    ]);

    res.json({
      users:             usersRes.rows,
      affiliates:        affiliatesRes.rows,
      viewerRole:        role,
      viewerAffiliateId: user.affiliateId,
      isOrgWide,
    });
  } catch (err) {
    console.error('Users route error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

module.exports = router;
