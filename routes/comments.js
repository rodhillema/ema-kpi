const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// All comment routes require admin PIN
router.use(requireAuth);

// GET /api/comments/ticket/:id — get comments for a ticket
router.get('/ticket/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT tc.*, tm."name"
      FROM "TicketComment" tc
      JOIN "TeamMember" tm ON tm."id" = tc."teamMemberId"
      WHERE tc."ticketId" = $1
      ORDER BY tc."createdAt" ASC
    `, [id]);

    res.json(rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST /api/comments/ticket/:id — add comment
router.post('/ticket/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { teamMemberId, body } = req.body;

    if (!teamMemberId || !body) {
      return res.status(400).json({ error: 'teamMemberId and body are required' });
    }

    const { rows } = await pool.query(`
      INSERT INTO "TicketComment" ("ticketId", "teamMemberId", "body")
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, teamMemberId, body]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// PATCH /api/comments/:id — edit comment
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;

    if (!body) {
      return res.status(400).json({ error: 'body is required' });
    }

    const { rows } = await pool.query(`
      UPDATE "TicketComment" SET "body" = $1, "updatedAt" = NOW()
      WHERE "id" = $2 RETURNING *
    `, [body, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating comment:', err);
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

module.exports = router;
