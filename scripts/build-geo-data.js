#!/usr/bin/env node
/* ============================================================
   build-geo-data.js — Generate ZIP and County FIPS lookups from
   public Census/HUD data sources.

   Outputs:
     lib/data/zip-to-county.json    — every US ZIP → primary county FIPS
     lib/data/county-fips.json      — every US county FIPS → canonical display name

   Usage:
     node scripts/build-geo-data.js

   Run quarterly (when Census refreshes) or whenever ĒMA expands to a
   new state. Both output files are committed to git so they ship with
   deploys; the script is just the regeneration tool.

   Sources (all public domain):
     - Census ZCTA-to-county relationship file (2020):
         https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/
         tab20_zcta520_county20_natl.txt
     - Census national_county.txt (county FIPS reference):
         https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt

   No external npm dependencies — uses Node builtin https + fs.
   ============================================================ */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'lib', 'data');

const ZCTA_TO_COUNTY_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt';
const NATIONAL_COUNTY_URL =
  'https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function titleCase(s) {
  return String(s || '').toLowerCase()
    .split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    .split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}

// ─────────────────────────────────────────────────────────────
// Build county-fips.json — every US county FIPS → canonical name
// Format: { '12011': 'Broward', '12086': 'Miami-Dade', ... }
// ─────────────────────────────────────────────────────────────

async function buildCountyNames() {
  console.log('[1/2] Fetching county FIPS reference from Census…');
  const csv = await fetchText(NATIONAL_COUNTY_URL);
  const out = {};
  const lines = csv.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    // Format: STATE,STATEFP,COUNTYFP,COUNTYNAME,CLASSFP
    // e.g.   AL,01,001,Autauga County,H1
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const stateFp = parts[1].trim();
    const countyFp = parts[2].trim();
    const countyName = parts[3].trim().replace(/\s+(County|Parish|Borough|Census Area|Municipality|Municipio)\s*$/i, '');
    if (!stateFp || !countyFp || !countyName) continue;
    if (!/^\d{2}$/.test(stateFp) || !/^\d{3}$/.test(countyFp)) continue;
    const fips = stateFp + countyFp;
    out[fips] = titleCase(countyName);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Build zip-to-county.json — every US ZIP → primary county FIPS
// Format: { '33442': '12011', '33068': '12011', ... }
// ─────────────────────────────────────────────────────────────

async function buildZipToCounty() {
  console.log('[2/2] Fetching ZCTA-to-county relationship file from Census…');
  const text = await fetchText(ZCTA_TO_COUNTY_URL);
  const out = {};
  const counts = {};  // zcta → [{ fips, weight }]
  const lines = text.split('\n');
  // Header row: GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|...|AREALAND_PART
  // Some files use comma-delim; handle both
  const sep = lines[0].includes('|') ? '|' : ',';
  const header = lines[0].split(sep).map((s) => s.trim());
  const zctaIdx = header.findIndex((h) => /ZCTA/i.test(h) && /GEOID/i.test(h));
  const countyIdx = header.findIndex((h) => /COUNTY/i.test(h) && /GEOID/i.test(h));
  const areaIdx = header.findIndex((h) => /AREALAND_PART/i.test(h));
  if (zctaIdx < 0 || countyIdx < 0) {
    throw new Error('ZCTA/county columns not found in relationship file: ' + header.join('|'));
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split(sep).map((s) => s.trim());
    const zip = parts[zctaIdx];
    const fips = parts[countyIdx];
    const area = areaIdx >= 0 ? parseFloat(parts[areaIdx]) || 0 : 1;
    if (!/^\d{5}$/.test(zip) || !/^\d{5}$/.test(fips)) continue;
    if (!counts[zip]) counts[zip] = [];
    counts[zip].push({ fips, weight: area });
  }
  // For ZIPs spanning multiple counties, pick the one with the largest land area
  // (rough proxy for "primary" — better than picking arbitrarily)
  for (const zip of Object.keys(counts)) {
    const entries = counts[zip];
    entries.sort((a, b) => b.weight - a.weight);
    out[zip] = entries[0].fips;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

(async function main() {
  try {
    if (!fs.existsSync(OUT_DIR)) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      console.log('Created ' + OUT_DIR);
    }

    const countyNames = await buildCountyNames();
    fs.writeFileSync(
      path.join(OUT_DIR, 'county-fips.json'),
      JSON.stringify(countyNames, null, 0) + '\n'
    );
    console.log(`✓ county-fips.json: ${Object.keys(countyNames).length} counties`);

    const zipMap = await buildZipToCounty();
    fs.writeFileSync(
      path.join(OUT_DIR, 'zip-to-county.json'),
      JSON.stringify(zipMap, null, 0) + '\n'
    );
    console.log(`✓ zip-to-county.json: ${Object.keys(zipMap).length} ZIPs`);

    console.log('\nDone. Commit lib/data/*.json to git so deploys have the lookup.');
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
})();
