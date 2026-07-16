const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'administrator') return next();
  res.status(403).json({ error: 'Access denied' });
}

// GET /api/flagged-needs?period=q1|q2|ytd&year=2026
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || 2026;
    const period = (req.query.period || 'ytd').toLowerCase();

    let startDate, endDate;
    if (period === 'q1') {
      startDate = `${year}-01-01`; endDate = `${year}-04-01`;
    } else if (period === 'q2') {
      startDate = `${year}-04-01`; endDate = `${year}-07-01`;
    } else if (period === 'ytd') {
      startDate = `${year}-01-01`; endDate = `${year + 1}-01-01`;
    } else {
      return res.status(400).json({ error: 'Invalid period — use q1, q2, or ytd' });
    }

    const { rows } = await pool.query(`
      SELECT
        COALESCE(af.name, 'Unknown')           AS affiliate_name,
        COALESCE(bn."type_c"::text, 'Other')   AS need_type,
        bn."is_urgent_c"                        AS urgent,
        bn."did_address_need_c"                 AS met,
        bn."advocacyGroupId" IS NOT NULL        AS is_group,
        bn."created_at",
        bn."provided_date_c",
        bn."resolved_date_c",
        bn."notes_c"                            AS notes
      FROM "BenevolenceNeed" bn
      JOIN  "Mom" m  ON m."id" = bn."momId"
      LEFT JOIN "Affiliate" af ON af."id" = m."affiliate_id"
      WHERE bn."created_at" >= $1
        AND bn."created_at" <  $2
        AND bn."deleted_at" = 0
    `, [startDate, endDate]);

    // Parse initiator role from notes_c (contains "nmsg_permissions: role_X")
    function initiatorRole(notes) {
      if (!notes) return 'unknown';
      const m = notes.match(/msg_permissions:\s*(role_\w+)/i);
      if (!m) return 'unknown';
      const r = m[1].toLowerCase();
      if (r === 'role_advocate' || r === 'role_staff_advocate') return 'advocate';
      if (r === 'role_coordinator' || r === 'role_supervisor' || r === 'role_administrator' || r === 'role_staff') return 'staff';
      return 'unknown';
    }

    // ── Roll-ups ────────────────────────────────────────────
    const affiliateMap = {};
    const typeMap      = {};
    let totalFlagged = 0, totalMet = 0;
    let urgentFlagged = 0, urgentMet = 0;
    let groupFlagged  = 0, groupMet  = 0;
    let openCount     = 0;
    let advocateFlagged = 0, advocateMet = 0;
    let staffFlagged    = 0, staffMet    = 0;
    let unknownFlagged  = 0, unknownMet  = 0;
    const fulfillDays = [];

    for (const r of rows) {
      totalFlagged++;
      if (r.met) totalMet++;
      if (!r.met) openCount++;

      // Urgency
      if (r.urgent) { urgentFlagged++; if (r.met) urgentMet++; }

      // Group vs individual
      if (r.is_group) { groupFlagged++; if (r.met) groupMet++; }

      // Initiator role
      const init = initiatorRole(r.notes);
      if (init === 'advocate') { advocateFlagged++; if (r.met) advocateMet++; }
      else if (init === 'staff') { staffFlagged++; if (r.met) staffMet++; }
      else { unknownFlagged++; if (r.met) unknownMet++; }

      // Time to fulfill (days from created_at to provided_date or resolved_date)
      const fulfilled = r.provided_date_c || r.resolved_date_c;
      if (r.met && fulfilled) {
        const days = Math.round((new Date(fulfilled) - new Date(r.created_at)) / 86400000);
        if (days >= 0 && days < 365) fulfillDays.push(days);
      }

      // By affiliate
      const aff = r.affiliate_name;
      if (!affiliateMap[aff]) affiliateMap[aff] = { affiliate: aff, flagged: 0, met: 0 };
      affiliateMap[aff].flagged++;
      if (r.met) affiliateMap[aff].met++;

      // By type
      const t = r.need_type;
      if (!typeMap[t]) typeMap[t] = { type: t, flagged: 0, met: 0 };
      typeMap[t].flagged++;
      if (r.met) typeMap[t].met++;
    }

    // Avg and median days to fulfill
    let avgDays = null, medianDays = null;
    if (fulfillDays.length) {
      avgDays = Math.round(fulfillDays.reduce((a, b) => a + b, 0) / fulfillDays.length);
      const sorted = [...fulfillDays].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianDays = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
    }

    res.json({
      period, year, startDate, endDate,
      total: { flagged: totalFlagged, met: totalMet, open: openCount },
      urgency: {
        urgent:  { flagged: urgentFlagged,                    met: urgentMet },
        routine: { flagged: totalFlagged - urgentFlagged,     met: totalMet - urgentMet },
      },
      delivery: {
        avgDays,
        medianDays,
        measuredCount: fulfillDays.length,
      },
      group: {
        group:      { flagged: groupFlagged,                   met: groupMet },
        individual: { flagged: totalFlagged - groupFlagged,    met: totalMet - groupMet },
      },
      byAffiliate: Object.values(affiliateMap).sort((a, b) => b.flagged - a.flagged),
      byType:      Object.values(typeMap).sort((a, b) => b.flagged - a.flagged),
      byInitiator: {
        advocate: { flagged: advocateFlagged, met: advocateMet },
        staff:    { flagged: staffFlagged,    met: staffMet },
        unknown:  { flagged: unknownFlagged,  met: unknownMet },
      },
    });
  } catch (err) {
    console.error('[flagged-needs]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
