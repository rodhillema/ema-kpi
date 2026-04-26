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
├── lib/
│   └── email.js            # SendGrid wrapper + branded invite/reset email templates
├── routes/
│   ├── report-data.js      # Main KPI endpoint — large Promise.all; mind array order (see note)
│   ├── advocates.js        # /api/advocates for Advocate Care Report
│   ├── champions.js        # /api/admin/champions — CRUD + bulk import (whitelisted admin only)
│   ├── champion-auth.js    # /api/champion/* — public token-based set/reset password
│   ├── tickets.js          # Ticket CRUD (legacy)
│   ├── schemas.js          # Form schema API
│   ├── team.js             # Team management
│   ├── attachments.js      # File upload (Cloudinary)
│   ├── reports.js          # Report data endpoints (legacy)
│   ├── timelogs.js         # Time log tracking
│   └── comments.js         # Ticket comments
├── public/
│   ├── hub.html            # Impact Hub landing page with login
│   ├── report.html         # Q1 Quarterly Impact Report — Cristina's layer
│   ├── advocate-care.html  # Advocate Care Report (coordinator-facing)
│   ├── admin-champions.html # Champion management UI (whitelisted admin only)
│   ├── set-password.html   # Champion invite token landing
│   ├── reset-password.html # Champion reset token landing
│   ├── integrity.html      # Data integrity explainer
│   ├── index.html          # Ticket submission portal (public)
│   ├── admin.html          # Ticket admin dashboard
│   ├── email-logo.png      # White ē logo referenced by email templates via APP_URL
│   ├── favicon.png         # Yellow ē favicon
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

**All KPIs are period-anchored** — they reflect activity during the reporting quarter specifically, not a rolling window from today. A Q1 2026 report viewed in April, July, or next year should yield identical numbers. Period constants in `routes/report-data.js`:
- `PERIOD_START = '2026-01-01'`
- `PERIOD_END = '2026-03-31'`
- `PERIOD_GRACE_END = '2026-04-30'` (30-day grace for late entries)

**All KPIs exclude PromiseServes Legacy assessments** (pre-Trellis migration data). Only current-system Trellis assessment templates count. See Assessment Data Capture Status below.

**KPI 1 — 85% Family Preservation Rate**
- Unit: child profiles (not moms)
- Numerator: children whose `family_preservation_impact` is `prevented_from_cps_involvement` OR `prevented_from_foster_care_placement`
- Denominator: children linked to moms who had at least one FWA logged between `PERIOD_START` and `PERIOD_GRACE_END` in a current Trellis template
- Does NOT require mom.status='active' currently — moms who were active during the period are included even if now inactive
- Exclude: PromiseServes Legacy template; children whose moms have no period-valid FWA in current Trellis templates (shown separately as "excluded" count)

**KPI 2 — 70% Improved FSS (Family Stability Score)**
- Composite across life-area question responses in `AssessmentResultQuestionResponse`
- Anchored on `Pairing.completed_on` falling in Q1 (same cohort as KPI 3). Assessment dates themselves not constrained — only track completion date.
- Denominator: moms who completed a pairing in Q1 AND have both a pre AND post assessment from current Trellis templates
- Numerator: subset where mom's overall post composite > overall pre composite
- Does NOT require mom.status='active' currently
- Exclude: PromiseServes Legacy template

**KPI 3 — 70% Learning Progress**
- Anchored on `Pairing.completed_on` in Q1 + `p.status='pairing_complete'` + `complete_reason_sub_status IS NOT NULL`
- Denominator: Q1 pairing completions with both pre and post AssessmentResult from current Trellis templates
- Numerator: subset where post composite > pre composite
- Exclude: PromiseServes Legacy template; NPP completions (no AAPI template exists in Trellis — see Assessment Data Capture Status)

**Always show numerator AND denominator for every rate — never a bare percentage.**

---

## Assessment Data Capture Status (Critical — as of April 2026)

**This section documents a major operational finding and affects all assessment-based KPIs.**

### Assessment templates in Trellis (`Assessment` table)
Only 5 templates exist:
1. Empowered Parenting Pre
2. Empowered Parenting Post
3. Resilience Pre-Assessment
4. Resilience Post-Assessment
5. PromiseServes Assessment (Legacy) — migrated pre-Trellis data, all timestamps 2021-2025

**No AAPI template exists.** `AAPIScore` table is empty. NPP (largest track) produces no assessment data in Trellis.

### Assessment row counts (as of April 2026)
```
PromiseServes Legacy:  3,057 rows (2,259 pre + 798 post) — ALL pre-Q1, migration data
Empowered Parenting Pre:    34 rows (Q1 2026 dates)
Empowered Parenting Post:    0 rows
Resilience Pre-Assessment:  25 rows (Q1 2026 dates)
Resilience Post-Assessment:  2 rows (Q1 2026 dates)
```

**~60 non-legacy assessments entered org-wide since Trellis launched December 2025.** Current-system assessment capture is not happening at scale — coordinators either aren't using Trellis for assessments or aren't closing the loop (many pres, almost no posts).

### Why KPI 2 / KPI 3 show "No Data" for most affiliates
Not a bug. Legitimate data reality:
- NPP-only affiliates have no assessment data (no AAPI template)
- Even EP/RR affiliates rarely have matching pre/post pairs in current Trellis
- Broward shows numbers because of its larger EP/RR volume; smaller affiliates don't

### Open decisions (pending Cristina)
1. Create AAPI template in Trellis + define AAPI→KPI scoring rules?
2. Import AAPI data from wherever it's currently captured (paper/Sheets/elsewhere)?
3. Assessment capture workflow — why aren't coordinators closing pres→posts?
4. Accept Q1 2026 limitations and re-check for Q2?

### Rule
When writing KPI queries that touch `AssessmentResult`:
- Always `JOIN "Assessment" a ON a."id" = ar."assessmentId"`
- Always filter `a."name" NOT ILIKE '%Legacy%'`
- Always constrain by period-anchored date (Pairing.completed_on or assessment completedAt/lastSaved in period + grace)
- Never use `m.status='active'` as a denominator filter — moms who were active-during-period should count regardless of current status

---

## Q1 Activity Methodology (advocates)

**Advocate Q1 Activity tile does NOT use `AuditLog`.** Attempt to diagnose AuditLog JSON shape via Railway query editor was unsuccessful (editor timeouts on JSONB column reads). Current query reads from `User` table directly:

- Applications = advocate users (advocate_status IS NOT NULL) whose User record was created in Q1
- Trained = Q1-created advocates with sub_status past Training_Completed (includes Paired, Waiting_To_Be_Paired, etc.)
- Approved = Q1-created advocates at Training_Completed specifically (excludes Taking_A_Break)
- Became Active = User records with status='Active' whose `updated_at` falls in Q1
- Became Inactive = same for status='Inactive'

**Limitation:** State-based proxy, not event-based. Won't capture advocates cycling through multiple states in Q1. Event-based tracking can be revisited when AuditLog JSON shape is diagnosable.

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

## Champion Management

Admin tooling at `/admin/champions` for managing Champion users (board members, donors, external viewers). Restricted to the `CHAMPION_ADMIN_WHITELIST` in `routes/champions.js` — currently `['rd.hill']`. Even other administrators don't see it.

### Features
- Create / list / edit / disable / permanently delete Champion users
- Resend invite email (fresh 48-hour token)
- Admin-triggered password reset (fresh 48-hour token, branded email)
- Bulk CSV import with preview, validation, and per-row results
- Per-row audit logging to Railway console

### Champion auth flow
- Trellis login fallback: `middleware/auth.js` tries `User` table first, then falls back to `ChampionUser` table
- Invite token (48hr) → `/set-password` → bcrypt store → login
- Reset token (48hr) → `/reset-password` → bcrypt update
- Self-service forgot-password was removed — admin handles all resets via `/admin/champions`. Trellis V2 will consolidate user management across the org.

### Three-layer access control on `/admin/champions`
1. Hub sidebar link hidden via JS for non-whitelisted users
2. Page-level check on `admin-champions.html` redirects non-whitelisted away
3. Backend `requireAdmin` middleware returns 403 for non-whitelisted

To add another admin, update `CHAMPION_ADMIN_WHITELIST` in `routes/champions.js` AND the frontend lists in `admin-champions.html` + `hub.html`.

---

## Email Infrastructure

**SendGrid** is the transactional email provider. Invite and reset emails use branded templates in `lib/email.js`.

### Configured via Railway env vars
- `SENDGRID_API_KEY` — from the SendGrid trial account
- `FROM_EMAIL` — `trellissupport@ema.org` (verified as Single Sender in SendGrid)
- `APP_URL` — `https://web-production-6efb7.up.railway.app` (or custom `impact.ema.org` if set)

### Domain authentication
`impact.ema.org` is authenticated for DKIM in SendGrid via 3 CNAME records in GoDaddy DNS:
- `em9200.impact.ema.org` → `u97689932.wl183.sendgrid.net`
- `s1._domainkey.impact.ema.org` → `s1.domainkey.u97689932.wl183.sendgrid.net`
- `s2._domainkey.impact.ema.org` → `s2.domainkey.u97689932.wl183.sendgrid.net`

Set as default DKIM domain in SendGrid. ema.org's existing DMARC uses relaxed alignment (default), so DKIM-signing with `impact.ema.org` is valid for `From: trellissupport@ema.org` under DMARC.

### Trellis's separate SendGrid account
Existing records at `_domainkey.ema.org` point to SendGrid account `u51724003` — Trellis's email-sending account. Do NOT overwrite those records. Impact Hub uses a different account (`u97689932`) and a subdomain to avoid conflict.

### Email template notes
- Google Fonts (Shrikhand, Oswald, Lato) are stripped by most email clients — fallbacks render: Georgia for serif, Helvetica/Arial for sans
- Logo served from `public/email-logo.png` via `${appUrl}/email-logo.png` (white ē mark, matches hub nav)
- Template colors match hub brand: red header (#ec482f), pink title bar, dark teal footer

---

## Promise.all Array Order (routes/report-data.js)

**Critical gotcha:** The `Promise.all([...])` array order MUST match the `const [ ... ] =` destructuring order. There's no compiler check — a mismatch silently assigns the wrong query's result to each variable.

A bug caused `advocate_q1_activity`, `families_served_expanded`, `advocate_active_breakdown`, and `children_welfare_involvement` to all show wrong data for a while because these 4 were misaligned. Fixed in commit `11f526c` by reordering the destructuring to match the query code order.

### Rule
When adding or moving queries in the `Promise.all`:
1. Count the position in the array (index from 0)
2. Match that exact position in the destructuring at the top
3. Test every downstream field on the page after the change

---

## Open Data Sourcing Gaps (as of Q1 2026)

- **AAPI assessment capture** (most urgent) — NPP tracks cannot be scored for KPI 2/3 until an AAPI template is added to Trellis and results are logged. Cristina decision pending.
- **EP/RR assessment capture** — only ~60 non-Legacy assessments logged org-wide since December 2025; coordinators start pres but rarely complete posts. Workflow adoption issue.
- **AuditLog JSON shape** — Railway query editor cannot render rows for diagnosis. When tooling improves (psql terminal or staging env), investigate to enable event-based Q1 Activity tracking.
- Q1 program spend — not in Trellis; needed for Cost Per Family; source TBD (finance)
- Staff headcount — not in Trellis; definition of "staff" needs alignment (coordinators only vs. broader)

---

## Key Contacts

- Cristina (cristina@ema.org) — data strategy lead, owns report HTML/CSS
- RD Hill — infrastructure lead, owns Express / SQL / auth / deployment / all backend
- Charnelle — first point of contact for affiliates on data support
- Jessie (jessie@ema.org) — affiliate contact
