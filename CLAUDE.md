# CLAUDE.md — ĒMA Oversight Dashboard

This file is read automatically by Claude Code on every session.
It contains all project rules, data model constraints, terminology, and architecture decisions.
Do not skip or summarize — these rules are load-bearing.

---

## Project Overview

**Client:** Every Mother's Advocate (ĒMA) — always spelled with a macron, never "EMA"
**App:** Q1 2026 HQ Program Oversight Report — a role-gated, affiliate-scoped dashboard
**Stack:** Node.js (Express) + pg + Railway PostgreSQL + express-session + static HTML frontend
**Hosting:** Railway
**Database:** Railway PostgreSQL — credentials via `DATABASE_URL` environment variable

---

## Repo Structure

```
/
├── server.js               # Express app, session config, page routes
├── db.js                   # pg Pool — Railway PostgreSQL connection
├── middleware/
│   └── auth.js             # Trellis login, bcrypt verify, role + affiliate lookup, requireAuth
├── routes/
│   ├── tickets.js          # Ticket CRUD
│   ├── schemas.js          # Form schema API
│   ├── team.js             # Team management
│   ├── attachments.js      # File upload (Cloudinary)
│   ├── reports.js          # Report data endpoints
│   ├── timelogs.js         # Time log tracking
│   └── comments.js         # Ticket comments
├── public/
│   ├── index.html          # Ticket submission portal (public)
│   ├── admin.html          # Ticket admin dashboard (auth required)
│   ├── report.html         # KPI Report — Cristina's layer, do not rewrite arbitrarily
│   ├── style.css           # Global styles
│   └── js/                 # Frontend scripts
├── package.json
├── CLAUDE.md               # This file
└── .env                    # Never commit — DB credentials, session secret
```

**Ownership rule:** RD owns everything outside `/public/report.html` and report-specific CSS/JS.
Cristina owns the report HTML and presentation layer.
Never rewrite her template HTML arbitrarily — her layout decisions are intentional.

---

## Development Workflow — Cristina's Live Data Pattern

Cristina edits `public/report.html` and sees real data without touching backend code.

### How it works
1. RD builds `/api/report-data` — returns the full KPI data dict as JSON, scoped by the logged-in user's affiliate
2. Cristina's `report.html` page fetches `/api/report-data` on load and renders it
3. She can iterate on layout/styling with live data from the DB — no fake data, no backend changes needed
4. The page is protected by `requireAuth` + `requireRole` — only coordinator and above can view it

### Rules
- Backend owns the data shape — if Cristina needs a new field, she asks RD to add it to the API
- Frontend owns the presentation — RD does not change her HTML/CSS without asking
- The `/api/report-data` response always includes `affiliate_name`, `role`, and `report_period` in its envelope so the frontend can display context

---

## Auth Architecture

This project uses the existing ĒMA Trellis login pattern (Node.js/Express + Railway PostgreSQL).
The pattern is already implemented in `middleware/auth.js` — do not introduce a different auth approach.

### Pattern Summary
- User submits username + password on login screen
- Optional: check username against hardcoded whitelist before DB query
- Query `User` table, run `bcrypt.compare()` against stored `passwordHash`
- Query `UserRole` join table + `Role` table to verify role meets minimum requirement
- On success: create express-session with 8-hour expiry
- All protected routes check for active session; unauthorized requests get 401

### Role Table
The `Role` table uses a `key` column (text). Known values:
```
administrator
supervisor
staff_advocate
coordinator
advocate
```

**Access gate for this dashboard: `coordinator` and above.**
Allowed roles: `coordinator`, `staff_advocate`, `supervisor`, `administrator`
Blocked roles: `advocate` (and any unrecognized role)

### Role Lookup Query
```sql
SELECT r."key"
FROM "UserRole" ur
JOIN "Role" r ON r."id" = ur."role_id"
WHERE ur."user_id" = $1
  AND ur."deleted_at" = '0'
```

### Affiliate Scoping by Role
- `coordinator`: filter all queries `WHERE affiliate_id = session.user.affiliate_id`
- `staff_advocate`: same as coordinator — affiliate-scoped
- `supervisor`: affiliate-scoped (same as coordinator) — confirmed April 2026
- `administrator`: no affiliate filter; frontend renders affiliate slicer dropdown in header
- `champion` with `affiliateId`: affiliate-scoped (like coordinator)
- `champion` without `affiliateId` (null): org-wide (like administrator, sees slicer)

### Whitelist (Optional Layer)
Hardcoded list at top of `middleware/auth.js`. Check username before any DB query.
The whitelist is an additional access gate — users NOT on the whitelist can still log in if their role qualifies.
Whitelisted users bypass the role check (useful for granting access to specific people regardless of role).
```javascript
const WHITELISTED_USERNAMES = ['rd.hill', 'cristina.galloway'];  // update as needed
```

### Session Config
In `server.js`:
```javascript
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,  // 8 hours
    sameSite: 'lax',              // never use 'strict' — silently drops cookies
  },
}));
```

### Session Payload (store on successful login)
```javascript
req.session.user = {
  id: user.id,
  username: user.username,
  firstName: user.firstName,
  role: roleKey,                  // e.g. 'coordinator'
  affiliate_id: user.affiliate_id,
  affiliate_name: affiliateName,  // looked up from Affiliate table
};
```

### Middleware Stack
```javascript
// Require authenticated session
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Require coordinator role or above
const ALLOWED_ROLES = ['coordinator', 'staff_advocate', 'supervisor', 'administrator'];
function requireRole(req, res, next) {
  if (ALLOWED_ROLES.includes(req.session.user.role)) return next();
  res.status(403).json({ error: 'Access denied — insufficient role' });
}
```

### Standard Routes
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | /api/login | None | Authenticate user |
| POST | /api/logout | Session | Destroy session |
| GET | /api/me | requireAuth | Check session / return role info |
| GET | /api/report-data | requireAuth + requireRole | KPI data JSON, affiliate-scoped |
| GET | /report | requireAuth + requireRole | Serve report.html |
| GET | / | None | Ticket submission portal |
| GET | /admin | None (client-side auth) | Ticket admin dashboard |

### Known Gotchas (from existing ĒMA tools)
- `sameSite: 'lax'` — do not change to strict; it silently drops cookies
- Sessions are in-memory by default — users must re-login after every Railway redeploy
- If the site shows stale content after a deploy, increment `CACHE_BUST` env var or hard-refresh

---

## Environment Variables

Set in Railway dashboard or `.env` file (never commit `.env`):

| Variable | Purpose |
|----------|---------|
| DATABASE_URL | PostgreSQL connection string (Railway) |
| SESSION_SECRET | Long random string for signing session cookies |
| PORT | Server port (Railway sets this automatically) |
| CLOUDINARY_URL | Cloudinary credentials for file uploads |
| NODE_ENV | `production` on Railway — enables SSL for pg connection |

---

## Tech Stack Rules (Hard-Won)

**pg + Railway:**
- All USER-DEFINED enum columns require explicit `::text` casting before string comparison:
  - `Mom.status`, `Pairing.status`, `Pairing.track_status`, `Session.status`, `User.advocate_status`
  - Example: `WHERE p."status"::text = 'paired'`
- Always use parameterized queries (`$1`, `$2`) — never string interpolation in SQL
- Quote all table and column names with double quotes — Railway PostgreSQL is case-sensitive

---

## Database — Confirmed SQL Rules

### Confirmed Enum Values (from Railway DB)
```
Mom.status:       'active', 'inactive'
Pairing.status:   'paired', 'pairing_complete', 'waiting_to_be_paired'
Session.status:   'Held', 'NotHeld', 'Planned'   (capitalized!)
Pairing.complete_reason_sub_status:   'completed_full_track', 'completed_without_post_assessment', 'completed_without_support_sessions'
Pairing.incomplete_reason_sub_status: 'achieved_outcomes', 'extended_wait', 'no_advocate', 'priorities_shifted'
```

### Active in Track
- Source: `"Pairing"` table ONLY — never the program track-status field
- `WHERE p."status"::text = 'paired'`
- Do NOT use `track_status` field for this — it is unreliable and not used for reporting

### Membership Community (never "Alumni")
- Client status Active AND no active pairing record
- `"Mom"."status"::text = 'active' AND NOT EXISTS (SELECT 1 FROM "Pairing" p WHERE p."momId" = m."id" AND p."status"::text = 'paired')`

### Stalled Moms
- Last **held** session (`s."status"::text = 'Held'`) > 14 days ago while pairing is paired
- Flagged needs do NOT reset the stall clock — held sessions only
- Rescheduling pattern (2+ planned sessions, no held session following) is a separate signal, not stall

### Track Completions
- Exclude same-day close/reopen duplicates (Trellis workaround for track-type changes)
- Complete variants: Completed Full Track / Completed without Support Sessions / Completed without Post Assessment
- Incomplete variants: Track Requirements Unmet / Client Choice / Relocated / Did Not Initiate Sessions / Other

### Required Sessions per Track
- Nurturing Parenting Program: 10 sessions
- Empowered Parenting: 8 sessions
- Roadmap to Resilience: 4 sessions

### Advocate Count
- 1:1 advocates: `Pairing.advocateUserId` — not coordinator/staff user ID
- Group facilitators: `AdvocacyGroup.advocateId` — separate table, `state` enum: active/completed/deleted/planned
- Union both for total active advocate count
- `_AdvocateToCoordinator` join table: `A` = advocate user ID, `B` = coordinator user ID

### Advocate Sub-Status Correction (deriveSub)
- `Active + Paired` with no active pairing AND no active group → corrected to `Waiting_To_Be_Paired` (mismatch flagged)
- `Active + Waiting_To_Be_Paired` with active pairing OR active group → corrected to `Paired` (mismatch flagged)
- Correction applied server-side in `/api/advocates` — not client-side

### Confirmed Advocate Enum Values
```
User.advocate_status:     'Active', 'Did_Not_Onboard', 'Inactive', 'Prospect'
User.advocate_sub_status: 'Interested', 'In_Training', 'Training_Completed', 'Waiting_To_Be_Paired', 
                          'Paired', 'Pending_Final_Steps', 'Taking_A_Break', 'Relocated',
                          'No_Longer_Interested', 'No_Longer_Interested_Onboard',
                          'Unable_To_Contact', 'Unresponsive', 'Advocate_Denied'
AdvocacyGroup.state:      'active', 'completed', 'deleted', 'planned'
```

### Children Impact
- Count children belonging to Active moms (active-during-period logic)
- If mom has no child count → substitute average child count of other moms as proxy
- Only count children mom still has legal authority over
- Children prevented from CPS = Child Welfare FWA domain — tracked separately, NOT in FSS composite

---

## KPI Definitions

**KPI 1 — 85% Family Preservation Rate**
- Unit: child profiles (not moms)
- Numerator: child profiles with family intact at FWA
- Denominator: children linked to moms with a valid in-window FWA
- FWA window: 3-month (confirm with RD if changed)
- Exclude: children with permanent custody removal

**KPI 2 — 70% Improved FSS (Family Stability Score)**
- Composite across 11 FWA domains (Child Welfare domain excluded from composite)
- Measured at intake, throughout program, and at completion
- Historical FWA baseline issue may affect improvement rate — flag if querying pre-Trellis data

**KPI 3 — 70% Learning Progress**
- % of mothers completing Nurturing Parenting or Roadmap to Resilience tracks with measurable improvement

**Always show numerator AND denominator for every rate — never a bare percentage.**

---

## FWA Data Integrity (Critical)

When ANY domain in the FWA is updated, the ENTIRE submission timestamp changes.
A mom may appear to have a "current" FWA when only one field was touched.

**Rule:** Never rely solely on FWA submission timestamp for currency checks.
**Rule:** Always flag when FWA coverage is low rather than silently computing a KPI.
**Rule:** Always note in comments when a query touches FWA data that timestamp alone cannot confirm full reassessment.

---

## Data Integrity Principles

- Never inflate denominators or credit outcomes without valid data
- When data is incomplete or missing, surface it explicitly — never silently include or exclude
- Always show numerator AND denominator: "X of Y eligible moms have valid FWA data"
- Families Served = active-during-period logic, NOT intake count
- No mom counted twice across sections of the same report
- DCF reporting (Jean Roger) is Broward-specific only — never conflate with org-wide KPI reporting
- Foster care cost estimates (~$35,000-$55,000/year) are framed as "estimated prevention value," not hard claims

---

## ĒMA Terminology — Strictly Enforced

| Never use | Always use |
|-----------|------------|
| EMA | **ĒMA** (with macron — Ē, not E) |
| Alumni | **Membership Community** |
| Discharged | Track Requirements Unmet / Client Choice / Relocated / Did Not Initiate Sessions / Other |

---

## Dashboard Brand Rules

**No blue anywhere — blue is not a brand color.**

**Colors:**
- Red-Orange (primary): `#ec482f`
- Red Dark: `#c23018`
- Red Light / Pink: `#f9ece8`
- Light Pink (page bg): `#fdf7f3`
- Green (dark teal): `#123939`
- Light Green: `#ecefe1`
- Yellow / Orange: `#f2a136`
- Dark text: `#2C2C2C`
- Mid text: `#5A5A5A`
- Border: `#E0E0E0`

**Typography (Google Fonts):**
- Shrikhand — report titles / H1
- Oswald Light 300 uppercase — section labels, tab nav, KPI names
- Lato — all body text

---

## Dashboard Tab Structure

1. KPIs & Status — core KPIs, efficiency metrics, mom status counts
2. End of Q1 Snapshot — entity counts (Moms/Advocates/Children), FWA currency, status distribution
3. FSS Deep Dive — domain-level FSS scores, trend chart, cohort stats
4. Affiliate Comparison — side-by-side KPIs + advocate metrics by affiliate
5. Track Oversight — stalled moms, track depth, fidelity flags, completion breakdown

---

## Open Data Sourcing Gaps (as of Q1 2026)

- Q1 program spend — not in Trellis; needed for Cost Per Family; source TBD (finance)
- Staff headcount — not in Trellis; definition of "staff" needs alignment (coordinators only vs. broader)
- Advocate status stages — confirm Trellis fields map to Interested → Trained → Active before publishing

---

## Key Contacts

- Cristina (cristina@ema.org) — data strategy lead, owns report HTML/CSS
- RD Hill — infrastructure lead, owns Express / SQL / auth / deployment / all backend
- Charnelle — first point of contact for affiliates on data support
- Jessie (jessie@ema.org) — affiliate contact
