# Geographic data lookup files

Source-of-truth JSON files for ZIP → county and county FIPS → display name
lookups. **Both files are checked into git** so production deploys have the
data without needing network access at startup.

## Files

| File | Format | Source |
|------|--------|--------|
| `zip-to-county.json` | `{ '33442': '12011', ... }` — every US ZIP → primary county FIPS | HUD/Census ZCTA-to-county relationship file |
| `county-fips.json` | `{ '12011': 'Broward', ... }` — county FIPS → canonical display name | Census `national_county.txt` |

These supplement the inline state-by-state lookup in `lib/county-fips.js`,
which is the manual fallback for states + alias variants (Miami-Dade vs Dade,
St. Johns vs Saint Johns, etc.).

## Regenerating

Run from the project root:

```bash
node scripts/build-geo-data.js
```

The script downloads the source files from public Census endpoints
(no API key, no auth, no network egress through paid services) and writes
both JSON files. Diff in git after running — if anything changed, commit.

**When to regenerate:**
- ĒMA expands to a new state (data is already national, so this is just hygiene)
- Quarterly when Census/HUD publish updates (county boundaries shift rarely
  but do change — recent example: Connecticut replaced counties with planning
  regions in 2022)
- After a code review flags a missing ZIP

## Graceful degradation

If `zip-to-county.json` is missing (fresh checkout, script never run),
`lib/zip-to-county.js` exports an empty object and the backend falls
through to text-county-field resolution. The 8-state inline coverage in
`lib/county-fips.js` continues to work as before. So the system works
out of the box; the JSON files just unlock nationwide ZIP-derived counties.

## File sizes (approximate)

- `zip-to-county.json` — ~600 KB (~42,000 entries)
- `county-fips.json` — ~80 KB (~3,143 entries)

Both files are gzip-friendly (high text repetition); committed sizes are
fine for git.
