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

// Middleware: require administrator role
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'administrator') return next();
  res.status(403).json({ error: 'Access denied — administrator role required' });
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

module.exports = router;
