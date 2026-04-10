const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// All report routes require admin PIN
router.use(requireAuth);

// GET /api/reports/summary — tickets by status and type counts
router.get('/summary', async (req, res) => {
  try {
    const [byStatus, byType, byPriority] = await Promise.all([
      pool.query(`SELECT "status", COUNT(*)::int AS "count" FROM "Ticket" GROUP BY "status"`),
      pool.query(`SELECT "type", COUNT(*)::int AS "count" FROM "Ticket" GROUP BY "type"`),
      pool.query(`SELECT "priority", COUNT(*)::int AS "count" FROM "Ticket" GROUP BY "priority"`)
    ]);

    res.json({
      byStatus: byStatus.rows,
      byType: byType.rows,
      byPriority: byPriority.rows
    });
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: 'Failed to fetch report summary' });
  }
});

// GET /api/reports/time — time by member
router.get('/time', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM "v_time_by_member"`);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching time report:', err);
    res.status(500).json({ error: 'Failed to fetch time report' });
  }
});

// GET /api/reports/resolution — avg resolution time by type
router.get('/resolution', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM "v_resolution_time_by_type"`);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching resolution report:', err);
    res.status(500).json({ error: 'Failed to fetch resolution report' });
  }
});

// GET /api/reports/volume — weekly ticket volume
router.get('/volume', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM "v_ticket_volume_weekly"`);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching volume report:', err);
    res.status(500).json({ error: 'Failed to fetch volume report' });
  }
});

// GET /api/reports/workload — open tickets per assignee
router.get('/workload', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        tm."id", tm."name", tm."email",
        COUNT(*) FILTER (WHERE t."status" = 'open')::int AS "openCount",
        COUNT(*) FILTER (WHERE t."status" = 'in_progress')::int AS "inProgressCount",
        COUNT(*)::int AS "totalAssigned"
      FROM "TicketAssignee" ta
      JOIN "TeamMember" tm ON tm."id" = ta."teamMemberId"
      JOIN "Ticket" t ON t."id" = ta."ticketId"
      WHERE t."status" NOT IN ('resolved', 'closed')
      GROUP BY tm."id", tm."name", tm."email"
      ORDER BY "totalAssigned" DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching workload:', err);
    res.status(500).json({ error: 'Failed to fetch workload report' });
  }
});

module.exports = router;
