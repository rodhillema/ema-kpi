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
app.use('/api/users', require('./routes/users'));
app.use('/api/admin/champions', requireAuth, require('./routes/champions'));
app.use('/api/admin/export', require('./routes/admin-export'));
app.use('/api/champion', require('./routes/champion-auth'));
app.use('/api/track-journey', require('./routes/track-journey'));
app.use('/api/child-welfare', require('./routes/child-welfare'));
app.use('/api/flagged-needs', require('./routes/flagged-needs'));
app.use('/api/kpi1-breakdown', require('./routes/kpi1-breakdown'));
app.use('/api/kpi2-trial', requireAuth, require('./routes/kpi2-trial'));

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

// AuditLog shape diagnostic — administrator only, read-only, temporary
app.get('/api/admin/audit-log-probe', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'administrator') return res.status(403).json({ error: 'Administrator only' });
  try {
    const [keys, advocateSample, q1Count, rawSample] = await Promise.all([
      // Which keys appear in data for User Update rows, and how often?
      pool.query(`
        SELECT jsonb_object_keys(data) AS key, COUNT(*)::int AS n
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
        GROUP BY key ORDER BY n DESC LIMIT 40
      `),
      // Any rows where data contains an advocate_status-like key?
      pool.query(`
        SELECT created_at, data
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
          AND (data ? 'advocate_status' OR data ? 'advocateStatus'
            OR data ? 'advocate_sub_status' OR data ? 'advocateSubStatus')
        ORDER BY created_at DESC LIMIT 10
      `),
      // How many User Update rows fall in Q1?
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
          AND created_at >= '2026-01-01' AND created_at <= '2026-03-31 23:59:59'
      `),
      // 5 raw rows — check the actual data shape
      pool.query(`
        SELECT created_at, action, data
        FROM "AuditLog"
        WHERE "table" = 'User' AND action = 'Update'
        ORDER BY created_at DESC LIMIT 5
      `),
    ]);
    res.json({
      keys: keys.rows,
      advocate_sample: advocateSample.rows,
      q1_user_update_count: q1Count.rows[0]?.count,
      raw_sample: rawSample.rows,
    });
  } catch (err) {
    console.error('audit-log-probe error:', err);
    res.status(500).json({ error: err.message });
  }
});


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
app.get('/report/users', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user-report.html')));
app.get('/integrity', (req, res) => res.sendFile(path.join(__dirname, 'public', 'integrity.html')));
app.get('/track-journey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'track-journey.html')));
app.get('/report/child-welfare-status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'child-welfare-status-report.html')));
app.get('/report/flagged-needs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flagged-needs.html')));
app.get('/report/kpi1-preservation-breakdown', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kpi1-preservation-breakdown.html')));
app.get('/report/kpi2-trial', requireAuth, (req, res) => {
  if ((req.session.user.username || '').toLowerCase() !== 'cristina.galloway') {
    return res.status(403).send('Access denied');
  }
  res.sendFile(path.join(__dirname, 'public', 'kpi2-trial.html'));
});

// Startup migrations — idempotent ALTER TABLE statements for new columns
pool.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "availability" text`)
  .then(() => console.log('[startup] User.availability column ready'))
  .catch(err => console.error('[startup] User.availability migration error:', err.message));

app.listen(PORT, () => {
  console.log(`ĒMA KPI Dashboard running on port ${PORT}`);
});
