/* ============================================================
   Champion Auth Routes — public (no session required)
   Handles set-password, reset-password, and forgot-password
   for ChampionUser accounts.
   ============================================================ */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { sendResetEmail } = require('../lib/email');

// GET /api/champion/verify-token?token=xxx&type=invite|reset
// Returns champion info (username, firstName) if token is valid — for displaying on set-password page
router.get('/verify-token', async (req, res) => {
  try {
    const { token, type } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const tokenCol = type === 'reset' ? 'resetToken' : 'inviteToken';
    const expiryCol = type === 'reset' ? 'resetExpiresAt' : 'inviteExpiresAt';

    const result = await pool.query(
      `SELECT "username", "firstName", "lastName", "email"
       FROM "ChampionUser"
       WHERE "${tokenCol}" = $1
         AND "${expiryCol}" > NOW()
         AND "deleted_at" = 0
       LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Token verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/champion/set-password
// Accepts invite token + new password, activates the champion account
router.post('/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    // Find champion with valid, unexpired invite token
    const result = await pool.query(
      `SELECT "id", "email", "firstName"
       FROM "ChampionUser"
       WHERE "inviteToken" = $1
         AND "inviteExpiresAt" > NOW()
         AND "deleted_at" = 0
       LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired invite link' });
    }

    const champion = result.rows[0];

    // Hash the new password
    const passwordHash = await bcrypt.hash(password, 10);

    // Activate account: set password, clear invite token
    await pool.query(
      `UPDATE "ChampionUser"
       SET "passwordHash" = $1,
           "status" = 'active',
           "inviteToken" = NULL,
           "inviteExpiresAt" = NULL
       WHERE "id" = $2`,
      [passwordHash, champion.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Champion set-password error:', err);
    res.status(500).json({ error: 'Failed to set password — please try again' });
  }
});

// POST /api/champion/reset-password
// Accepts reset token + new password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    // Find champion with valid, unexpired reset token
    const result = await pool.query(
      `SELECT "id", "email", "firstName"
       FROM "ChampionUser"
       WHERE "resetToken" = $1
         AND "resetExpiresAt" > NOW()
         AND "deleted_at" = 0
       LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const champion = result.rows[0];

    // Hash the new password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update password, clear reset token
    await pool.query(
      `UPDATE "ChampionUser"
       SET "passwordHash" = $1,
           "resetToken" = NULL,
           "resetExpiresAt" = NULL
       WHERE "id" = $2`,
      [passwordHash, champion.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Champion reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password — please try again' });
  }
});

// POST /api/champion/forgot-password
// Generates a reset token and sends email (never reveals whether email exists)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Always return success to avoid revealing whether the email exists
    const result = await pool.query(
      `SELECT "id", "email", "firstName"
       FROM "ChampionUser"
       WHERE "email" = $1
         AND "deleted_at" = 0
         AND "status" != 'disabled'
       LIMIT 1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length > 0) {
      const champion = result.rows[0];

      // Generate secure reset token
      const resetToken = crypto.randomBytes(32).toString('hex');

      // Set token with 48-hour expiry
      await pool.query(
        `UPDATE "ChampionUser"
         SET "resetToken" = $1,
             "resetExpiresAt" = NOW() + INTERVAL '48 hours'
         WHERE "id" = $2`,
        [resetToken, champion.id]
      );

      // Send reset email
      await sendResetEmail({
        email: champion.email,
        firstName: champion.firstName,
        resetToken,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Champion forgot-password error:', err);
    res.status(500).json({ error: 'Failed to process request — please try again' });
  }
});

module.exports = router;
