# ĒMA Impact Hub

Q1 2026 HQ Program Oversight Report — a role-gated, affiliate-scoped dashboard for Every Mother's Advocate.

## Stack
- **Backend:** Node.js (Express) + pg + Railway PostgreSQL
- **Frontend:** Static HTML + vanilla JS
- **Auth:** Trellis login (bcrypt) + Champion user system
- **Hosting:** Railway
- **Email:** SendGrid (invite/reset flows)

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Impact Hub — login + report navigation |
| `/report/quarterly/q1-2026` | Q1 2026 Program Oversight Report |
| `/report/advocate-care` | Advocate Care Report (live) |
| `/admin/champions` | Champion user management (admin only) |

## Getting Started

```bash
npm install
cp .env.example .env   # add your DATABASE_URL, SESSION_SECRET
node server.js
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Railway PostgreSQL connection string |
| `SESSION_SECRET` | Session cookie signing |
| `NODE_ENV` | `production` on Railway |
| `SENDGRID_API_KEY` | Email delivery for Champion invites |
| `FROM_EMAIL` | Sender email address |
| `APP_URL` | Public URL for email links |
