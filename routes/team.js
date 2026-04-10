const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/team — list active team members (used in assignee dropdowns)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM "TeamMember" WHERE "isActive" = true ORDER BY "name" ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listing team:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// POST /api/team — add team member (admin)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, email, role } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const { rows } = await pool.query(`
      INSERT INTO "TeamMember" ("name", "email", "role")
      VALUES ($1, $2, $3)
      RETURNING *
    `, [name, email, role || 'tech']);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A team member with this email already exists' });
    }
    console.error('Error adding team member:', err);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

// PATCH /api/team/:id — update team member (admin)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, isActive } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    if (name) { sets.push(`"name" = $${idx++}`); params.push(name); }
    if (email) { sets.push(`"email" = $${idx++}`); params.push(email); }
    if (role) { sets.push(`"role" = $${idx++}`); params.push(role); }
    if (isActive !== undefined) { sets.push(`"isActive" = $${idx++}`); params.push(isActive); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE "TeamMember" SET ${sets.join(', ')} WHERE "id" = $${idx} RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating team member:', err);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

module.exports = router;
