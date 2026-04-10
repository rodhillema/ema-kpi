const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/tickets — list with filters (admin)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, type, priority, assignee, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`t."status" = $${idx++}`); params.push(status); }
    if (type) { conditions.push(`t."type" = $${idx++}`); params.push(type); }
    if (priority) { conditions.push(`t."priority" = $${idx++}`); params.push(priority); }
    if (assignee) {
      conditions.push(`EXISTS (
        SELECT 1 FROM "TicketAssignee" ta
        WHERE ta."ticketId" = t."id" AND ta."teamMemberId" = $${idx++}
      )`);
      params.push(assignee);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const { rows } = await pool.query(`
      SELECT t.*,
        (SELECT json_agg(json_build_object(
          'id', ta."id",
          'teamMemberId', ta."teamMemberId",
          'isPrimary', ta."isPrimary",
          'name', tm."name"
        ))
        FROM "TicketAssignee" ta
        JOIN "TeamMember" tm ON tm."id" = ta."teamMemberId"
        WHERE ta."ticketId" = t."id"
        ) AS assignees
      FROM "Ticket" t
      ${where}
      ORDER BY t."createdAt" DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "Ticket" t ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({ tickets: rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('Error listing tickets:', err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// GET /api/tickets/:id — single ticket with full details (admin)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const ticket = await pool.query(`SELECT * FROM "Ticket" WHERE "id" = $1`, [id]);
    if (ticket.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const [assignees, attachments, timeLogs, comments] = await Promise.all([
      pool.query(`
        SELECT ta.*, tm."name", tm."email"
        FROM "TicketAssignee" ta
        JOIN "TeamMember" tm ON tm."id" = ta."teamMemberId"
        WHERE ta."ticketId" = $1
        ORDER BY ta."isPrimary" DESC, ta."assignedAt" ASC
      `, [id]),
      pool.query(`
        SELECT * FROM "TicketAttachment"
        WHERE "ticketId" = $1
        ORDER BY "uploadedAt" ASC
      `, [id]),
      pool.query(`
        SELECT tl.*, tm."name"
        FROM "TimeLog" tl
        JOIN "TeamMember" tm ON tm."id" = tl."teamMemberId"
        WHERE tl."ticketId" = $1
        ORDER BY tl."loggedAt" DESC
      `, [id]),
      pool.query(`
        SELECT tc.*, tm."name"
        FROM "TicketComment" tc
        JOIN "TeamMember" tm ON tm."id" = tc."teamMemberId"
        WHERE tc."ticketId" = $1
        ORDER BY tc."createdAt" ASC
      `, [id])
    ]);

    res.json({
      ...ticket.rows[0],
      assignees: assignees.rows,
      attachments: attachments.rows,
      timeLogs: timeLogs.rows,
      comments: comments.rows
    });
  } catch (err) {
    console.error('Error fetching ticket:', err);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// POST /api/tickets — create ticket (public, no auth)
router.post('/', async (req, res) => {
  try {
    const {
      type, title, description, priority,
      submitterName, submitterEmail, submitterRole,
      advocateId, advocateName,
      formSchemaId, fieldValues,
      attachments
    } = req.body;

    if (!type || !title || !submitterName || !submitterEmail) {
      return res.status(400).json({ error: 'Missing required fields: type, title, submitterName, submitterEmail' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ticketResult = await client.query(`
        INSERT INTO "Ticket" (
          "type", "title", "description", "priority",
          "submitterName", "submitterEmail", "submitterRole",
          "advocateId", "advocateName",
          "formSchemaId", "fieldValues"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        type, title, description || null, priority || 'medium',
        submitterName, submitterEmail, submitterRole || null,
        advocateId || null, advocateName || null,
        formSchemaId || null, JSON.stringify(fieldValues || {})
      ]);

      const ticket = ticketResult.rows[0];

      // Save attachment records if provided
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          await client.query(`
            INSERT INTO "TicketAttachment"
              ("ticketId", "cloudinaryUrl", "publicId", "filename", "mimeType", "sizeBytes", "uploadedBy")
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [ticket.id, att.cloudinaryUrl, att.publicId, att.filename, att.mimeType || null, att.sizeBytes || null, submitterName]);
        }
      }

      await client.query('COMMIT');
      res.status(201).json(ticket);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error creating ticket:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// PATCH /api/tickets/:id — update ticket (admin)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, resolutionNote } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    if (status) {
      sets.push(`"status" = $${idx++}`);
      params.push(status);
      if (status === 'resolved' || status === 'closed') {
        sets.push(`"resolvedAt" = NOW()`);
      }
    }
    if (priority) { sets.push(`"priority" = $${idx++}`); params.push(priority); }
    if (resolutionNote !== undefined) { sets.push(`"resolutionNote" = $${idx++}`); params.push(resolutionNote); }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    sets.push(`"updatedAt" = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE "Ticket" SET ${sets.join(', ')} WHERE "id" = $${idx} RETURNING *`,
      params
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating ticket:', err);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// --- Assignee sub-routes ---

// POST /api/tickets/:id/assignees
router.post('/:id/assignees', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { teamMemberId, isPrimary } = req.body;

    if (!teamMemberId) {
      return res.status(400).json({ error: 'teamMemberId is required' });
    }

    const { rows } = await pool.query(`
      INSERT INTO "TicketAssignee" ("ticketId", "teamMemberId", "isPrimary")
      VALUES ($1, $2, $3)
      ON CONFLICT ("ticketId", "teamMemberId") DO UPDATE SET "isPrimary" = $3
      RETURNING *
    `, [id, teamMemberId, isPrimary || false]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error adding assignee:', err);
    res.status(500).json({ error: 'Failed to add assignee' });
  }
});

// DELETE /api/tickets/:id/assignees/:teamMemberId
router.delete('/:id/assignees/:teamMemberId', requireAuth, async (req, res) => {
  try {
    const { id, teamMemberId } = req.params;
    await pool.query(
      `DELETE FROM "TicketAssignee" WHERE "ticketId" = $1 AND "teamMemberId" = $2`,
      [id, teamMemberId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing assignee:', err);
    res.status(500).json({ error: 'Failed to remove assignee' });
  }
});

// PATCH /api/tickets/:id/assignees/:teamMemberId
router.patch('/:id/assignees/:teamMemberId', requireAuth, async (req, res) => {
  try {
    const { id, teamMemberId } = req.params;
    const { isPrimary } = req.body;

    const { rows } = await pool.query(`
      UPDATE "TicketAssignee"
      SET "isPrimary" = $3
      WHERE "ticketId" = $1 AND "teamMemberId" = $2
      RETURNING *
    `, [id, teamMemberId, isPrimary]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Assignee not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating assignee:', err);
    res.status(500).json({ error: 'Failed to update assignee' });
  }
});

module.exports = router;
