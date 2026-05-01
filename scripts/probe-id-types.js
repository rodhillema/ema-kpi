const pool = require('../db');
(async () => {
  const { rows } = await pool.query(`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name IN ('User','Affiliate','ChampionUser')
      AND column_name IN ('id')
    ORDER BY table_name;
  `);
  console.table(rows);
  await pool.end();
})();
