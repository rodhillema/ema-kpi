# Track Journey — Product Knowledge Document

**ĒMA Impact Hub · Q1 2026**
_Last updated: May 2026_

---

## What is the Track Journey page?

Track Journey is a coordinator-facing tool inside the Impact Hub that lets staff view the full program history for any active or recently completed mom–advocate pairing. It is built for oversight: understanding where a mom is in her track, whether she has stalled, what outreach has been attempted, and what vital support needs are on file.

The page reads directly from Trellis. There is no manual data entry — everything shown comes from sessions, assessments, connection logs, and need records already logged in Trellis.

---

## Who can access it?

| Role | Access |
|------|--------|
| Administrator | Yes — sees all affiliates; affiliate slicer appears |
| Supervisor | Yes — scoped to their affiliate |
| Staff Advocate | Yes — scoped to their affiliate |
| Coordinator | Yes — scoped to their affiliate |
| Advocate | No |
| Champion | No |

Org-wide users (`rd.hill`, `cristina.galloway`) see all affiliates regardless of role.

---

## Page Layout

```
┌─ Report Header ─────────────────────────────────────────────────────────────┐
│  Track Journey          [Affiliate ▾]  [Mom search…]  [Track (display)] Live │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Pairing Strip ─────────────────────────────────────────────────────────────┐
│  MOM · TRACK · PROGRAM STATUS                                                │
│  ADVOCATE · PAIRING WINDOW · TRACK LENGTH · COORDINATOR                     │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Track Timeline Card ───────────────────────────────────────────────────────┐
│  CURRICULUM · Learning     ●─────●─────◎─────────────                       │
│  SUPPORT · Belonging       ♥─────────────♥─────────────                     │
│  FLAGGED NEEDS · Vital Supports  ⚑──────────────⚑──────                    │
│                             Dec      Jan      Feb      Mar      Apr          │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Curriculum Detail ─────────────┬─ Assessment Detail ─────────────────────┐
│  3/10 CURRICULUM LESSONS        │  PRE-ASSESSMENT                          │
│  COMPLETED  BELOW STANDARD      │  Empowered Parenting Pre · Completed     │
│                                 │                                           │
│  PRE  Pre-Assessment            │  POST-ASSESSMENT                         │
│  ●1   Attachment & Connection   │  Not completed                           │
│  ●2   Meeting Basic Needs ×3    │                                           │
│  ◎3   Discipline vs. Punishment │  ─── Per-question bars (EP/RR) ───       │
│  ○4   Disruption & Reconnection │  A · Expectations  ████░░  3.4           │
│  ...                            │  B · Empathy       ███░░░  2.9           │
└─────────────────────────────────┴───────────────────────────────────────────┘
```

---

## Header Controls

### Mom Search (top right)
A type-ahead search box. Start typing a mom's name to filter the list of active and recently completed pairings scoped to your affiliate. Selecting a mom loads her full journey.

### Affiliate Slicer (org-wide users only)
Administrators see an **Affiliate** dropdown in the header. Changing it re-loads the mom list for that affiliate. Coordinators do not see this — they are automatically scoped to their own affiliate.

### Track Display
The Track field next to the mom search is display-only. It reflects the track associated with the selected pairing.

### "Live" Badge
Indicates the page reads directly from Trellis. Reload to see the latest data — there is no cache.

---

## Pairing Strip

A neutral white bar that appears once a mom is selected. It shows seven fields across two rows:

| Field | What it shows |
|-------|--------------|
| **Mom** | Full name |
| **Track** | Track title (e.g., Empowered Parenting, Nurturing Parenting Program) |
| **Program Status** | Paired / Track Complete — sourced from `Pairing.status` |
| **Advocate** | Advocate's name + delivery type suffix: "· 1:1" for individual, "· Group" for group-delivered tracks |
| **Pairing Window** | Start date → end date (or "present" if still active) |
| **Track Length** | Days elapsed from pairing start to today (or completion), with approximate week count |
| **Coordinator** | The coordinator most recently associated with the pairing's advocate via coordinator notes |

---

## Track Timeline

The timeline is a horizontal Gantt-style visualization spanning from the pairing start date to today (or the completion date for completed tracks). The x-axis is a proportional date scale; the y-axis has three lanes.

### Lane 1 — Curriculum · Learning
Shows every **Track Session** recorded in Trellis for this pairing.

| Mark | Meaning |
|------|---------|
| Filled dark circle | Completed curriculum session (Held) |
| Amber circle (in-progress ring) | Most recent session — the current lesson |
| Number inside circle | Lesson sequence number |
| ×3 badge on a lesson | The same lesson was held 3 times (repeats shown) |

### Lane 2 — Support · Belonging
Shows **Support Sessions** (non-curriculum sessions: support calls, check-ins, etc.).

| Mark | Meaning |
|------|---------|
| Heart icon (filled) | Held support session |
| Chain-link icon | Pairing date marker |

### Lane 3 — Flagged Needs · Vital Supports
Shows **BenevolenceNeed** records from Trellis (the "Vital Support" tab). Each need is plotted at its request date.

| Mark | Meaning |
|------|---------|
| Flag icon (amber) | Open or in-progress need |
| Flag icon (green) | Resolved / fulfilled need |

Clicking a flag mark opens the **Flag / Need Drawer** for that specific need.

### Stall Bands
Overlaid on the timeline as shaded vertical regions:

| Band | Color/Style | Condition |
|------|-------------|-----------|
| General Stall | Red, solid borders | Any held-session gap ≥14 days |
| Curriculum Stall | Amber, dashed borders | Track-session gap ≥30 days with a support session present in the gap |

Stall bands are labeled with their duration (e.g., `GENERAL STALL · 30D`). Bands can be historical (the pairing had a stall that was resolved) or active (ongoing as of today).

### Timeline Info Popover
An `ⓘ` icon next to "Track Timeline" opens an inline legend explaining marks, stall logic, and known limitations. Key caveat surfaced there: **planned breaks and sessions not yet entered in Trellis look like stalls**. Coordinator notes provide the context in both cases.

---

## Stall Drawer

Opens by clicking a stall band on the timeline. Slides in from the right. Contains four sections.

### Header
- **Eyebrow**: Current Stall or Past Stall · days · stall type (e.g., `CURRENT STALL · 21 DAYS · COMMUNICATION STALL`)
- **Title**: Mom's full name
- **Sub-line**: Track abbreviation · last held lesson · last held date (e.g., `EP · Lesson 1 · Last held Apr 16, 2026`)
- **Outreach summary line** (orange): `N outreach attempts during this period · no response` — appears when connection log entries exist in the stall window

### Section 1 — At a Glance
A prose summary in a bordered box with the key facts:
- Days since last held session
- Number of outreach attempts during the stall period
- Date of last contact
- Count and type of active flagged needs

### Section 2 — Flagged Needs Active
Lists any **BenevolenceNeed** records that are currently open (not resolved or fulfilled). Shows:
- Need type (e.g., Childcare gap, Housing)
- Urgency status (Urgent / Open)
- Context note (first 80 characters)

If no active needs exist, shows "No active flagged needs."

### Section 3 — Outreach Attempted (N)
Shows all contact attempts during the stall window, newest first. Combines two sources:
1. **Connection Log entries** (`ConnectionLog` table, keyed to mom) — coordinator/advocate outreach calls, texts, emails
2. **Missed Sessions** (`Session.status = 'NotHeld'`) — sessions that were scheduled but the mom did not attend

Each entry shows:
- **Type chip** (color-coded): `Call · Outbound` (teal), `Text · Outbound` (teal), `Missed Session` (red)
- **Date** (right-aligned)
- **Person · Role** (e.g., Lily Tchividjian · Coordinator)
- **Note** (what happened — up to 200 characters)

### Section 4 — Full Activity Feed
A complete chronological view of everything that happened during the stall window, sorted newest first. Includes:
- Sessions held (amber chip) — who held it
- Missed sessions (red chip) — which lesson was scheduled
- Connection log entries (teal chip) — outreach call/text details
- Coordinator notes (green chip) — narrative notes written about the advocate/family

---

## Flag / Need Drawer

Opens when a flag mark is clicked on the Flagged Needs lane of the timeline. Distinct from the stall drawer — only one drawer is open at a time.

Three states based on whether a **ServiceReferral** record is linked to the need:

| State | Header Color | Meaning |
|-------|-------------|---------|
| **Resolved** | Green | A ServiceReferral exists with `outcome = successful` |
| **Referred** | Amber | A ServiceReferral exists but outcome is not yet successful |
| **Open** | Amber | No ServiceReferral linked — no services connected yet |

### Sections
1. **Need** — type, context note, status pill (Resolved / Urgent / Open)
2. **Status** — plain text: "Resolved — a referral was completed successfully" / "In progress — a referral is open" / "Open — no services connected yet"
3. **Connected Services** — if a referral exists: service type, provider, start date, outcome, who created the referral
4. **Notes** — any coordinator notes on the need record

---

## Curriculum Detail Panel

Located in the left half of the bottom card. Shows the full lesson sequence for the selected track.

### Header
`X / Y CURRICULUM SESSIONS HELD` — actual held sessions vs. required sessions for the track.

Required session counts:
- Nurturing Parenting Program: 10
- Empowered Parenting: 8
- Roadmap to Resilience: 4

A red `BELOW COMPLETION STANDARD` badge appears if the mom has fewer than the required sessions and the track is not complete.

### Lesson List
Each row is a unique lesson or session type, in order:

| Indicator | Meaning |
|-----------|---------|
| Dark filled circle | Completed (held) |
| Amber in-progress circle | Most recent lesson — currently in progress |
| Empty circle | Not yet held |
| `PRE` bubble | Pre-assessment |
| `POST` bubble (dashed) | Post-assessment (pending if dashed) |
| `×N` sessions badge | The lesson was repeated N times |

Session names are pulled from the `Session.name` field in Trellis (the lesson template name).

---

## Assessment Detail Panel

Located in the right half of the bottom card. Shows pre and post assessment data.

### EP and RR tracks (Empowered Parenting / Roadmap to Resilience)
These tracks use the `AssessmentResult` + `AssessmentResultQuestionResponse` tables in Trellis.

- **PRE-ASSESSMENT** section: shows assessment name and completion date. If completed, shows per-question bars.
- **POST-ASSESSMENT** section: same structure. If not completed, shows "Not completed."

**Per-question bars** (when data available): each question in the assessment is shown as a horizontal bar:
- Label (e.g., "A · Expectations")
- Bar fill proportional to the response score (1–7 Likert scale)
- Score value displayed to the right
- Pre and post bars shown side by side when both available, making progress visible at a glance

Scale is computed from actual min/max values across all non-Legacy assessment responses in the system.

### NPP tracks (Nurturing Parenting Program)
NPP uses the `AAPIScore` table (5 constructs A–E). When AAPI data is available:
- Pre and post shown as labeled construct scores (A = Expectations, B = Empathy, C = Discipline, D = Family Roles, E = Empowerment)
- Total score displayed

### Known limitation — assessment data gaps
As of Q1 2026, Trellis has very few completed assessment records outside of Broward:
- No AAPI template exists in Trellis — NPP assessments are not entered at scale
- EP/RR: many pres exist but almost no posts
- The assessment panel will show "Not completed" or be empty for most moms — this reflects actual data capture, not a system bug

---

## Data Sources

| Data shown | Source table(s) |
|-----------|----------------|
| Pairing header fields | `Pairing`, `Mom`, `Track`, `User` (advocate + coordinator) |
| Sessions (all types) | `Session` — by `pairing_id` or `advocacy_group_id` |
| Stall computation | Derived from Session hold dates (no separate table) |
| EP/RR assessments | `AssessmentResult`, `AssessmentResultQuestionResponse`, `AssessmentQuestion` |
| NPP assessments | `AAPIScore` |
| Connection log entries | `ConnectionLog` — keyed by `mom_id` |
| Coordinator notes | `CoordinatorNote` — keyed by advocate user ID |
| Flagged needs | `BenevolenceNeed` — keyed by `mom_id` or `advocacyGroupId` |
| Service referrals | `ServiceReferral` — keyed by `mom_id`, joined to `BenevolenceNeed` via `benevolence_need_id` |
| Affiliate list | `Affiliate` (via session / auth layer) |

All data is **affiliate-scoped** for coordinators and supervisors. Administrators see all affiliates.

---

## Stall Logic (Reference)

Stalls are computed server-side from the session history. The algorithm:

**Curriculum Stall** (amber/dashed):
- Gap between consecutive Track_Session held dates ≥ 30 days
- AND at least one Support_Session is held within that gap
- Rationale: the mom is still engaged (support session present) but the curriculum track has stopped

**General / Communication Stall** (red/solid):
- Gap between any consecutive held session dates ≥ 14 days
- NOT fully contained within a curriculum stall band (to avoid double-counting)

**Active vs. Past**:
- The most recent band extending to "today" (or the pairing end date) is `isActive = true`
- Historical bands are `isActive = false` — they appear on the timeline as past events

---

## Known Limitations

1. **Planned breaks look like stalls** — if a family took a planned vacation or pause, Trellis has no "pause" record. The timeline will show a stall band. Coordinator notes are the only source of context.

2. **Sessions not yet entered** — if a session was held but not logged in Trellis yet, it cannot be shown and may extend an apparent stall.

3. **NPP assessment data** — no AAPI template exists in Trellis as of Q1 2026. NPP tracks will not show pre/post assessment bars until the template is created and coordinators begin entering scores.

4. **EP/RR post-assessments** — very few exist. Most moms show a pre-assessment but no post. This is a workflow adoption issue, not a system bug.

5. **Coordinator name** — the coordinator shown in the pairing strip is derived from coordinator notes. If no coordinator notes exist for the advocate, the field shows "—".

6. **Connection Log direction** — all connection log entries are shown as "Outbound" since Trellis does not record a direction field. Inbound contacts from moms captured in notes (not call logs) will appear in coordinator notes instead.

---

## Glossary

| Term | Meaning |
|------|---------|
| Pairing | The record linking a mom to an advocate for a specific track. A mom can have multiple pairings over time. |
| Track | The curriculum program (NPP, EP, RR). Each pairing is associated with one track. |
| Track Session | A curriculum lesson session (`Session.session_type = Track_Session`). |
| Support Session | A non-curriculum session — support call, check-in, etc. |
| General Stall | 14+ day gap between any held sessions. |
| Curriculum Stall | 30+ day gap between curriculum sessions, with a support session in the gap. |
| Connection Log | A coordinator/advocate contact record for a mom (`ConnectionLog` table). Not to be confused with Coordinator Notes. |
| Coordinator Note | A narrative note written by a coordinator about an advocate or family. |
| BenevolenceNeed | A flagged support need (food, housing, childcare, etc.) logged in Trellis's Vital Support tab. |
| ServiceReferral | A record of a service being connected to a mom's need. Linked to BenevolenceNeed via `benevolence_need_id`. |
| AAPI | Adult-Adolescent Parenting Inventory — the assessment tool for NPP tracks. Score stored in `AAPIScore` table. |
| Advocacy Type | Whether the pairing is individual (1:1) or group-delivered. |
