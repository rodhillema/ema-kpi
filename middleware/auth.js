/* ============================================================
   Trellis Login Authentication
   - Session-based (express-session)
   - Verifies password via bcrypt against User.passwordHash
   - Checks role via UserRole + Role tables (coordinator and above)
   - Whitelist bypasses role check for specific users
   ============================================================ */

const bcrypt = require('bcryptjs');
const pool = require('../db');

// Approved usernames — these bypass the role check entirely
const WHITELISTED_USERNAMES = ['rd.hill', 'cristina.galloway'];

// Roles allowed to access the KPI dashboard (coordinator and above + champion)
const ALLOWED_ROLES = ['coordinator', 'staff_advocate', 'supervisor', 'administrator', 'champion'];

// Middleware: require authenticated session
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Middleware: require coordinator role or above
function requireRole(req, res, next) {
  if (ALLOWED_ROLES.includes(req.session.user.role)) return next();
  res.status(403).json({ error: 'Access denied — insufficient role' });
}

// Login handler — validates Trellis credentials
async function login(req, res) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const normalizedUsername = username.trim().toLowerCase();

    // 1. Find user in Trellis User table + affiliate name
    const userResult = await pool.query(
      `SELECT u."id", u."username", u."firstName", u."lastName", u."passwordHash", u."affiliateId",
              a."name" AS "affiliateName"
       FROM "User" u
       LEFT JOIN "Affiliate" a ON a."id" = u."affiliateId"
       WHERE LOWER(u."username") = $1 AND u."deleted_at" = 0
       LIMIT 1`,
      [normalizedUsername]
    );

    // ── Try Trellis User first ──
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const passwordValid = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;

      if (passwordValid) {
        // ChampionAccess grant lets a Trellis user (e.g. an advocate) get
        // champion-level Hub access using their existing Trellis password.
        const [roleResult, grantResult] = await Promise.all([
          pool.query(
            `SELECT r."key"
             FROM "UserRole" ur
             JOIN "Role" r ON r."id" = ur."role_id"
             WHERE ur."user_id" = $1 AND ur."deleted_at" = 0
             LIMIT 1`,
            [user.id]
          ),
          pool.query(
            `SELECT ca."affiliateId", a."name" AS "affiliateName"
             FROM "ChampionAccess" ca
             LEFT JOIN "Affiliate" a ON a."id" = ca."affiliateId"
             WHERE ca."userId" = $1 AND ca."deleted_at" = 0
             LIMIT 1`,
            [user.id]
          ),
        ]);
        const roleKey = roleResult.rows.length > 0 ? roleResult.rows[0].key : null;
        const grant = grantResult.rows[0] || null;
        const isWhitelisted = WHITELISTED_USERNAMES.includes(normalizedUsername);

        if (isWhitelisted || ALLOWED_ROLES.includes(roleKey) || grant) {
          const role = grant ? 'champion' : roleKey;
          const affiliateId = grant ? grant.affiliateId : user.affiliateId;
          const affiliateName = grant ? grant.affiliateName : user.affiliateName;

          req.session.user = {
            id: user.id,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            role,
            affiliateId,
            affiliateName,
          };
          return res.json({
            success: true,
            firstName: user.firstName,
            role,
            affiliateName,
          });
        }
      }
      // Password wrong or role insufficient — fall through to ChampionUser
    }

    // ── Fallback: try ChampionUser table ──
    const championResult = await pool.query(
      `SELECT c."id", c."username", c."firstName", c."lastName", c."passwordHash",
              c."affiliateId", c."status", a."name" AS "affiliateName"
       FROM "ChampionUser" c
       LEFT JOIN "Affiliate" a ON a."id" = c."affiliateId"
       WHERE LOWER(c."username") = $1 AND c."deleted_at" = 0
       LIMIT 1`,
      [normalizedUsername]
    );

    if (championResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const champion = championResult.rows[0];

    if (champion.status === 'disabled') {
      return res.status(403).json({ error: 'Account disabled — contact your administrator' });
    }

    if (champion.status === 'invited' || !champion.passwordHash) {
      return res.status(403).json({ error: 'Please complete your account setup using the invite link sent to your email' });
    }

    const champPasswordValid = await bcrypt.compare(password, champion.passwordHash);
    if (!champPasswordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Create champion session
    req.session.user = {
      id: champion.id,
      username: champion.username,
      firstName: champion.firstName,
      lastName: champion.lastName,
      role: 'champion',
      affiliateId: champion.affiliateId,
      affiliateName: champion.affiliateName,
    };

    res.json({
      success: true,
      firstName: champion.firstName,
      role: 'champion',
      affiliateName: champion.affiliateName,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed — please try again' });
  }
}

// Logout handler
function logout(req, res) {
  req.session.destroy(() => res.json({ success: true }));
}

// Session check handler
function me(req, res) {
  res.json({ user: req.session.user });
}

module.exports = { requireAuth, requireRole, login, logout, me };
