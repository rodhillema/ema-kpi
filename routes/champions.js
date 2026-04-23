/* ============================================================
   /api/admin/champions — Champion User Management (Admin Only)
   CRUD endpoints for ChampionUser records.
   All routes require authenticated administrator session.
   ============================================================ */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendInviteEmail, sendResetEmail } = require('../lib/email');

// Whitelist — only these usernames can access Champion Management, even among administrators
// Add additional usernames here if you later want to delegate this capability
const CHAMPION_ADMIN_WHITELIST = ['rd.hill'];

// Middleware: require administrator role AND whitelisted username
function requireAdmin(req, res, next) {
  const u = req.session.user;
  if (!u || u.role !== 'administrator') {
    return res.status(403).json({ error: 'Access denied — administrator role required' });
  }
  const uname = (u.username || '').toLowerCase();
  if (!CHAMPION_ADMIN_WHITELIST.includes(uname)) {
    return res.status(403).json({ error: 'Access denied — Champion Management is restricted' });
  }
  next();
}

// Apply auth + admin check to all routes
router.use(requireAuth, requireAdmin);

// GET / — List all champions
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c."id",
        c."email",
        c."username",
        c."firstName",
        c."lastName",
        c."affiliateId",
        a."name" AS "affiliateName",
        c."status",
        c."created_at"
      FROM "ChampionUser" c
      LEFT JOIN "Affiliate" a ON a."id" = c."affiliateId" AND a."deleted_at" = 0
      WHERE c."deleted_at" = 0
      ORDER BY c."created_at" DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error listing champions:', err);
    res.status(500).json({ error: 'Failed to fetch champions' });
  }
});

// POST / — Create champion + send invite email
router.post('/', async (req, res) => {
  try {
    const { email, username, firstName, lastName, affiliateId } = req.body;

    if (!email || !username || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, username, firstName, and lastName are required' });
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const { rows } = await pool.query(`
      INSERT INTO "ChampionUser" (
        "email", "username", "firstName", "lastName",
        "affiliateId", "status", "inviteToken", "inviteExpiresAt",
        "deleted_at", "created_at"
      )
      VALUES ($1, $2, $3, $4, $5, 'invited', $6, $7, 0, NOW())
      RETURNING
        "id", "email", "username", "firstName", "lastName",
        "affiliateId", "status", "created_at"
    `, [email, username, firstName, lastName, affiliateId || null, inviteToken, inviteExpiresAt]);

    const champion = rows[0];

    // Send invite email (fire-and-forget — don't block response on email delivery)
    sendInviteEmail({ email, firstName, username, inviteToken }).catch(err => {
      console.error('Failed to send invite email to', email, err);
    });

    console.log(`[AUDIT] Champion created: ${username} (${email}) by ${req.session.user.username}`);
    res.status(201).json(champion);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A champion with this email or username already exists' });
    }
    console.error('Error creating champion:', err);
    res.status(500).json({ error: 'Failed to create champion' });
  }
});

// PUT /:id — Update champion
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = ['firstName', 'lastName', 'email', 'affiliateId', 'status'];
    const sets = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        sets.push(`"${field}" = $${paramIndex}`);
        values.push(req.body[field]);
        paramIndex++;
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    const { rows } = await pool.query(`
      UPDATE "ChampionUser"
      SET ${sets.join(', ')}
      WHERE "id" = $${paramIndex} AND "deleted_at" = 0
      RETURNING
        "id", "email", "username", "firstName", "lastName",
        "affiliateId", "status", "created_at"
    `, values);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Champion not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating champion:', err);
    res.status(500).json({ error: 'Failed to update champion' });
  }
});

// DELETE /:id — Soft-delete (disable) champion
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const now = Math.floor(Date.now() / 1000);

    const { rowCount } = await pool.query(`
      UPDATE "ChampionUser"
      SET "status" = 'disabled', "deleted_at" = $1
      WHERE "id" = $2 AND "deleted_at" = 0
    `, [now, id]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Champion not found or already disabled' });
    }

    console.log(`[AUDIT] Champion disabled: ${id} by ${req.session.user.username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error disabling champion:', err);
    res.status(500).json({ error: 'Failed to disable champion' });
  }
});

// DELETE /:id/permanent — Permanently delete champion (hard delete)
router.delete('/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(`
      DELETE FROM "ChampionUser"
      WHERE "id" = $1
      RETURNING "username", "email"
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Champion not found' });
    }

    console.log(`[AUDIT] Champion permanently deleted: ${rows[0].username} (${rows[0].email}) by ${req.session.user.username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting champion:', err);
    res.status(500).json({ error: 'Failed to delete champion' });
  }
});

// GET /export-referral-partners.csv — Export of Agency referral partners with data-quality flags
// Whitelisted admin only. Scoped to agencies with at least 1 referral since Jan 1 2026
// (skips PromiseServes Legacy-era agencies no longer in use).
// Set ?all=true to include legacy-only agencies too.
router.get('/export-referral-partners.csv', async (req, res) => {
  try {
    const includeLegacy = req.query.all === 'true';
    const havingClause = includeLegacy
      ? ''
      : `HAVING SUM(CASE WHEN m."created_at" >= '2026-01-01' THEN 1 ELSE 0 END) > 0`;

    const { rows } = await pool.query(`
      WITH agency_stats AS (
        SELECT
          a."id" AS agency_id,
          a."name" AS agency_name,
          COUNT(m."id")::int AS total_referrals_lifetime,
          SUM(CASE WHEN m."created_at" >= '2026-01-01' THEN 1 ELSE 0 END)::int AS referrals_since_2026,
          SUM(CASE WHEN m."created_at" >= '2026-01-01' AND m."created_at" <= '2026-03-31 23:59:59' THEN 1 ELSE 0 END)::int AS q1_2026_referrals,
          SUM(CASE WHEN m."created_at" >= '2026-01-01' AND m."prospect_status"::text = 'engaged_in_program' THEN 1 ELSE 0 END)::int AS engaged_2026,
          SUM(CASE WHEN m."created_at" >= '2026-01-01' AND m."prospect_status"::text = 'did_not_engage_in_program' THEN 1 ELSE 0 END)::int AS did_not_engage_2026,
          SUM(CASE WHEN m."created_at" >= '2026-01-01' AND m."prospect_status"::text IN ('prospect','prospect_intake_scheduled') THEN 1 ELSE 0 END)::int AS pending_2026,
          STRING_AGG(DISTINCT CASE WHEN m."created_at" >= '2026-01-01' THEN aff."name" END, '; ' ORDER BY CASE WHEN m."created_at" >= '2026-01-01' THEN aff."name" END) AS affiliates_using_in_2026
        FROM "Agency" a
        LEFT JOIN "Mom" m ON m."agency_id" = a."id" AND m."deleted_at" = 0
        LEFT JOIN "Affiliate" aff ON aff."id" = m."affiliate_id"
        WHERE a."deleted_at" = 0
        GROUP BY a."id", a."name"
        ${havingClause}
      )
      SELECT
        agency_id AS id_token,
        agency_name,
        referrals_since_2026,
        q1_2026_referrals,
        engaged_2026,
        did_not_engage_2026,
        pending_2026,
        total_referrals_lifetime,
        affiliates_using_in_2026,
        CASE WHEN agency_name ~ '^[0-9a-f]{8}-' THEN 'UUID placeholder - needs rename'
             WHEN agency_name IS NULL OR TRIM(agency_name) = '' THEN 'Blank - needs rename'
             WHEN LENGTH(TRIM(agency_name)) < 4 THEN 'Suspiciously short - likely data entry issue'
             ELSE ''
        END AS data_quality_flag,
        LOWER(TRIM(REGEXP_REPLACE(COALESCE(agency_name,''), '[^a-zA-Z0-9]', '', 'g'))) AS normalized_for_dedup
      FROM agency_stats
      ORDER BY referrals_since_2026 DESC, agency_name;
    `);

    // CSV escape: wrap field in quotes; escape embedded quotes by doubling them
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const header = [
      'id_token','agency_name','referrals_since_2026','q1_2026_referrals',
      'engaged_2026','did_not_engage_2026','pending_2026','total_referrals_lifetime',
      'affiliates_using_in_2026','data_quality_flag','normalized_for_dedup',
    ];

    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(header.map((k) => esc(r[k])).join(','));
    }

    console.log(`[AUDIT] Referral partners exported by ${req.session.user.username}: ${rows.length} rows`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="referral-partners-export.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('Referral partners export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /import-template.csv — Download a blank CSV template for bulk import
router.get('/import-template.csv', (req, res) => {
  const csv = [
    'firstName,lastName,email,username,affiliate',
    'Jane,Doe,jane.doe@example.org,jane.doe,Broward',
    'John,Smith,john.smith@example.org,john.smith,',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="champion-import-template.csv"');
  res.send(csv);
});

// POST /bulk-import — Bulk create champions from CSV data + send invites
// Body: { champions: [{ firstName, lastName, email, username, affiliate }, ...] }
// affiliate is a name string or UUID — resolved server-side; blank = org-wide
router.post('/bulk-import', async (req, res) => {
  try {
    const { champions } = req.body;
    if (!Array.isArray(champions) || champions.length === 0) {
      return res.status(400).json({ error: 'champions array is required' });
    }
    if (champions.length > 500) {
      return res.status(400).json({ error: 'Import limited to 500 rows per batch' });
    }

    // Load all affiliates once for name matching
    const { rows: affiliates } = await pool.query(
      `SELECT "id", "name" FROM "Affiliate" WHERE "deleted_at" = 0`
    );
    const affiliatesByName = {};
    const affiliatesById = {};
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const a of affiliates) {
      affiliatesByName[a.name.toLowerCase().trim()] = a.id;
      affiliatesById[a.id] = a.name;
    }

    const results = {
      total: champions.length,
      created: 0,
      skipped: 0,
      failed: 0,
      details: [], // [{ row, status, email, message, affiliateName }]
    };

    const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

    for (let i = 0; i < champions.length; i++) {
      const row = champions[i];
      const rowNum = i + 2; // account for header row
      const firstName = (row.firstName || '').trim();
      const lastName = (row.lastName || '').trim();
      const email = (row.email || '').trim().toLowerCase();
      const username = (row.username || '').trim().toLowerCase();
      const affiliateRaw = (row.affiliate || '').trim();

      // Validate required fields
      if (!firstName || !lastName || !email || !username) {
        results.failed++;
        results.details.push({
          row: rowNum,
          status: 'failed',
          email,
          message: 'Missing required field (firstName, lastName, email, or username)',
        });
        continue;
      }
      if (!isEmail(email)) {
        results.failed++;
        results.details.push({
          row: rowNum,
          status: 'failed',
          email,
          message: 'Invalid email format',
        });
        continue;
      }

      // Resolve affiliate (optional — blank means org-wide)
      let affiliateId = null;
      let affiliateName = null;
      if (affiliateRaw) {
        if (uuidRegex.test(affiliateRaw)) {
          // Provided a UUID
          if (affiliatesById[affiliateRaw]) {
            affiliateId = affiliateRaw;
            affiliateName = affiliatesById[affiliateRaw];
          } else {
            results.failed++;
            results.details.push({
              row: rowNum,
              status: 'failed',
              email,
              message: `Affiliate UUID not found: ${affiliateRaw}`,
            });
            continue;
          }
        } else {
          // Match by name (case-insensitive)
          const key = affiliateRaw.toLowerCase();
          if (affiliatesByName[key]) {
            affiliateId = affiliatesByName[key];
            affiliateName = affiliatesById[affiliateId]; // canonical name
          } else {
            // Unknown affiliate — skip the row with an error
            results.failed++;
            results.details.push({
              row: rowNum,
              status: 'failed',
              email,
              message: `Affiliate not found: "${affiliateRaw}"`,
            });
            continue;
          }
        }
      }

      // Check for existing champion (email or username)
      try {
        const dupCheck = await pool.query(
          `SELECT "id", "email", "username" FROM "ChampionUser"
           WHERE (LOWER("email") = $1 OR LOWER("username") = $2) AND "deleted_at" = 0
           LIMIT 1`,
          [email, username]
        );
        if (dupCheck.rows.length > 0) {
          results.skipped++;
          results.details.push({
            row: rowNum,
            status: 'skipped',
            email,
            message: 'Already exists (email or username in use)',
          });
          continue;
        }

        // Create champion + invite token
        const inviteToken = crypto.randomBytes(32).toString('hex');
        const inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

        await pool.query(
          `INSERT INTO "ChampionUser" (
            "email", "username", "firstName", "lastName",
            "affiliateId", "status", "inviteToken", "inviteExpiresAt",
            "deleted_at", "created_at"
          )
          VALUES ($1, $2, $3, $4, $5, 'invited', $6, $7, 0, NOW())`,
          [email, username, firstName, lastName, affiliateId, inviteToken, inviteExpiresAt]
        );

        // Send invite email (small delay between sends to be gentle on SendGrid)
        try {
          await sendInviteEmail({ email, firstName, username, inviteToken });
        } catch (emailErr) {
          console.error(`[IMPORT] Email failed for ${email}:`, emailErr.message);
          // Record partial success — champion created, email failed
          results.details.push({
            row: rowNum,
            status: 'created-no-email',
            email,
            message: 'Champion created but invite email failed to send — use Resend Invite',
            affiliateName,
          });
          results.created++;
          // Continue to next row with small delay anyway
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        results.created++;
        results.details.push({
          row: rowNum,
          status: 'created',
          email,
          message: 'Created + invited',
          affiliateName,
        });

        // Small delay between sends
        await new Promise(r => setTimeout(r, 200));
      } catch (rowErr) {
        console.error(`[IMPORT] Row ${rowNum} failed:`, rowErr);
        results.failed++;
        results.details.push({
          row: rowNum,
          status: 'failed',
          email,
          message: rowErr.code === '23505' ? 'Database duplicate (email or username)' : 'Database error',
        });
      }
    }

    console.log(`[AUDIT] Bulk import by ${req.session.user.username}: ${results.created} created, ${results.skipped} skipped, ${results.failed} failed of ${results.total} rows`);

    res.json(results);
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// POST /:id/resend-invite — Resend invite email with fresh token
router.post('/:id/resend-invite', async (req, res) => {
  try {
    const { id } = req.params;
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const { rows } = await pool.query(`
      UPDATE "ChampionUser"
      SET "inviteToken" = $1, "inviteExpiresAt" = $2
      WHERE "id" = $3 AND "deleted_at" = 0
      RETURNING "email", "firstName", "username"
    `, [inviteToken, inviteExpiresAt, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Champion not found' });
    }

    const { email, firstName, username } = rows[0];

    sendInviteEmail({ email, firstName, username, inviteToken }).catch(err => {
      console.error('Failed to resend invite email to', email, err);
    });

    console.log(`[AUDIT] Invite resent: ${username} (${email}) by ${req.session.user.username}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error resending invite:', err);
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// POST /:id/send-password-reset — Admin-triggered password reset email for an active champion
// Generates a reset token (1-hour expiry) and sends the branded reset email.
// Used when a champion forgets their password — replaces the self-service forgot-password flow.
router.post('/:id/send-password-reset', async (req, res) => {
  try {
    const { id } = req.params;
    const resetToken = crypto.randomBytes(32).toString('hex');

    const { rows } = await pool.query(
      `UPDATE "ChampionUser"
       SET "resetToken" = $1,
           "resetExpiresAt" = NOW() + INTERVAL '48 hours'
       WHERE "id" = $2 AND "deleted_at" = 0
       RETURNING "email", "firstName", "username", "status"`,
      [resetToken, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Champion not found' });
    }

    const { email, firstName, username, status } = rows[0];

    if (status === 'invited') {
      return res.status(400).json({ error: 'Champion has not yet activated their account — use Resend Invite instead' });
    }
    if (status === 'disabled') {
      return res.status(400).json({ error: 'Champion is disabled — re-enable before sending a reset' });
    }

    sendResetEmail({ email, firstName, resetToken }).catch(err => {
      console.error('Failed to send reset email to', email, err);
    });

    console.log(`[AUDIT] Password reset sent: ${username} (${email}) by ${req.session.user.username}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error sending password reset:', err);
    res.status(500).json({ error: 'Failed to send password reset' });
  }
});

module.exports = router;
