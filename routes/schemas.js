const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/schemas/:ticketType — fetch active schema (public)
router.get('/:ticketType', async (req, res) => {
  try {
    const { ticketType } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM "FormSchema" WHERE "ticketType" = $1 AND "isActive" = true LIMIT 1`,
      [ticketType]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No active schema found for this ticket type' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching schema:', err);
    res.status(500).json({ error: 'Failed to fetch schema' });
  }
});

// GET /api/schemas — list all schemas (admin)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM "FormSchema" ORDER BY "ticketType", "createdAt" DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listing schemas:', err);
    res.status(500).json({ error: 'Failed to fetch schemas' });
  }
});

// PATCH /api/schemas/:id — update fields JSON (admin, Phase 2)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { fields, label, isActive } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    if (fields) { sets.push(`"fields" = $${idx++}`); params.push(JSON.stringify(fields)); }
    if (label) { sets.push(`"label" = $${idx++}`); params.push(label); }
    if (isActive !== undefined) { sets.push(`"isActive" = $${idx++}`); params.push(isActive); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    sets.push(`"updatedAt" = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE "FormSchema" SET ${sets.join(', ')} WHERE "id" = $${idx} RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Schema not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating schema:', err);
    res.status(500).json({ error: 'Failed to update schema' });
  }
});

module.exports = router;
