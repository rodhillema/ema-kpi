/* ============================================================
   ZIP → County FIPS lookup

   Used by routes/report-data.js as the PRIMARY source for resolving a
   mom's county. The text Mom.primary_address_county_c field is used as
   FALLBACK only when the ZIP is missing or unrecognized.

   Why ZIP-derived is better than text county:
     - ZIPs are entered consistently (5 digits, no variants)
     - One ZIP → one canonical county FIPS (no "Broward" vs "Broward county" issues)
     - Census + HUD maintain authoritative ZIP-county relationships nationwide
     - As ĒMA expands to new states, ZIP-derived works immediately —
       no per-state code update needed

   Data file: lib/data/zip-to-county.json
     Shape: { '33442': '12011', '33068': '12011', ... }
     One entry per US ZIP, mapping to its primary county FIPS.

   To regenerate: run `node scripts/build-geo-data.js`
     Pulls Census ZCTA-to-county relationship file (public domain) and
     writes the JSON above. Re-run quarterly when Census refreshes.

   Graceful degradation:
     If lib/data/zip-to-county.json doesn't exist (fresh checkout, script
     not yet run), this module exports an empty object {}. The backend
     falls through to text-county-field resolution. Existing 8-state
     coverage in lib/county-fips.js continues to work as before.
   ============================================================ */

const fs = require('fs');
const path = require('path');

let ZIP_TO_COUNTY = {};

try {
  const dataPath = path.join(__dirname, 'data', 'zip-to-county.json');
  if (fs.existsSync(dataPath)) {
    ZIP_TO_COUNTY = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const zipCount = Object.keys(ZIP_TO_COUNTY).length;
    console.log(`[zip-to-county] Loaded ${zipCount} ZIP→county mappings`);
  } else {
    console.log('[zip-to-county] No data file found at ' + dataPath +
      ' — falling back to text county field. Run scripts/build-geo-data.js to populate.');
  }
} catch (err) {
  console.warn('[zip-to-county] Failed to load lookup data:', err.message);
  ZIP_TO_COUNTY = {};
}

/**
 * Resolve a ZIP code to its primary county FIPS (5-digit).
 * Accepts ZIP strings of any length, normalizes to first 5 digits.
 * Returns null if ZIP is invalid or not in the lookup.
 */
function lookupZipCounty(zip) {
  if (!zip) return null;
  const z = String(zip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  return ZIP_TO_COUNTY[z] || null;
}

module.exports = { ZIP_TO_COUNTY, lookupZipCounty };
