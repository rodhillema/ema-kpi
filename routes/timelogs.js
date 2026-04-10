const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// All time log routes require admin PIN
router.use(requireAuth);

// GET /api/timelogs/ticket/:id — get time entries for a ticket
router.get('/ticket/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT tl.*, tm."name"
      FROM "TimeLog" tl
      JOIN "TeamMember" tm ON tm."id" = tl."teamMemberId"
      WHERE tl."ticketId" = $1
      ORDER BY tl."loggedAt" DESC
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Error fetching time logs:', err);
    res.status(500).json({ error: 'Failed to fetch time logs' });
  }
});

// POST /api/timelogs/ticket/:id — log time entry
router.post('/ticket/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { teamMemberId, minutes, note } = req.body;

    if (!teamMemberId || !minutes) {
      return res.status(400).json({ error: 'teamMemberId and minutes are required' });
    }

    if (minutes <= 0) {
      return res.status(400).json({ error: 'Minutes must be greater than 0' });
    }

    const { rows } = await pool.query(`
      INSERT INTO "TimeLog" ("ticketId", "teamMemberId", "minutes", "note")
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, teamMemberId, minutes, note || null]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error logging time:', err);
    res.status(500).json({ error: 'Failed to log time' });
  }
});

// DELETE /api/timelogs/:id — delete time entry
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM "TimeLog" WHERE "id" = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting time log:', err);
    res.status(500).json({ error: 'Failed to delete time log' });
  }
});

module.exports = router;
