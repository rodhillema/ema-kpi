require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const pool = require('./db');
const { login, logout, me, requireAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ema-tickets-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', requireAuth, me);

// API routes
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/schemas', require('./routes/schemas'));
app.use('/api/team', require('./routes/team'));
app.use('/api/upload', require('./routes/attachments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/timelogs', require('./routes/timelogs'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/report-data', requireAuth, requireRole, require('./routes/report-data'));
app.use('/api/advocates', require('./routes/advocates'));
app.use('/api/mom-status', require('./routes/mom-status'));
app.use('/api/admin/champions', requireAuth, require('./routes/champions'));
app.use('/api/champion', require('./routes/champion-auth'));

// Generic HIPAA export audit endpoint — shared by advocate-care.html and mom-status-report.html.
// Both pages POST { timestamp, recordCount, recordIds, filters } here on CSV export.
// Logged to Railway console for compliance; kept intentionally lightweight (no DB write yet).
app.post('/api/export-audit', requireAuth, express.json(), (req, res) => {
  try {
    const user = req.session.user;
    const { timestamp, recordCount, recordIds, filters } = req.body || {};
    const source = req.get('referer') || 'unknown';
    console.log(`[EXPORT-AUDIT] ${user.username} (${user.role}) exported ${recordCount || 0} records at ${timestamp || new Date().toISOString()} from ${source}`);
    console.log(`[EXPORT-AUDIT] Filters: ${JSON.stringify(filters || {})}`);
    console.log(`[EXPORT-AUDIT] Record IDs: ${JSON.stringify(recordIds || [])}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Export audit error:', err);
    res.status(500).json({ error: 'Audit log failed' });
  }
});

// Lightweight affiliate list — used by slicers (fast, no KPI queries)
app.get('/api/affiliates', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT "id", "name" FROM "Affiliate" WHERE "deleted_at" = 0 ORDER BY "name"`
    );
    res.json(rows);
  } catch (err) {
    console.error('Affiliates lookup error:', err);
    res.status(500).json({ error: 'Failed to load affiliates' });
  }
});

// Advocate lookup — queries shared User table (same DB as Reset Tool)
app.get('/api/advocate-lookup/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT "id", "firstName", "lastName" FROM "User" WHERE "id" = $1 AND "deleted_at" = 0 LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Advocate not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Advocate lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'hub.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/champions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-champions.html')));
app.get('/set-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'set-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/report/quarterly/q1-2026', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/report/advocate-care', (req, res) => res.sendFile(path.join(__dirname, 'public', 'advocate-care.html')));
app.get('/report/mom-status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mom-status-report.html')));
app.get('/integrity', (req, res) => res.sendFile(path.join(__dirname, 'public', 'integrity.html')));

app.listen(PORT, () => {
  console.log(`ĒMA KPI Dashboard running on port ${PORT}`);
});
