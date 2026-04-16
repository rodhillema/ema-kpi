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
app.use('/api/admin/champions', requireAuth, require('./routes/champions'));
app.use('/api/champion', require('./routes/champion-auth'));

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
app.get('/integrity', (req, res) => res.status(200).send('<html><body style="font-family:Lato,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#5A5A5A"><h2>Data Integrity — Coming Soon</h2></body></html>'));

app.listen(PORT, () => {
  console.log(`ĒMA KPI Dashboard running on port ${PORT}`);
});
