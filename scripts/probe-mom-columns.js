// Run: node scripts/probe-mom-columns.js
// Prints all Mom table columns + any that contain marital/status keywords.
// Use output to determine correct column name for marital status probe in report-data.js.
const pool = require('../db');

(async () => {
  const { rows: all } = await pool.query(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Mom'
    ORDER BY column_name
  `);

  console.log('\n── All Mom columns ──');
  console.table(all);

  const keywords = ['marital', 'civil', 'status', 'relation', 'partner', 'family', 'living'];
  const matches = all.filter(r =>
    keywords.some(k => r.column_name.toLowerCase().includes(k))
  );

  console.log('\n── Columns matching marital/status keywords ──');
  console.table(matches.length ? matches : [{ column_name: '(none matched)' }]);

  // Also sample a few values from any matched columns
  for (const { column_name } of matches) {
    try {
      const { rows } = await pool.query(
        `SELECT "${column_name}", COUNT(*)::int AS cnt FROM "Mom" WHERE "${column_name}" IS NOT NULL AND "${column_name}"::text != '' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
      );
      console.log(`\n── Sample values for ${column_name} ──`);
      console.table(rows.length ? rows : [{ value: '(all null/empty)' }]);
    } catch (e) {
      console.log(`\n── ${column_name}: ${e.message}`);
    }
  }

  await pool.end();
})();
