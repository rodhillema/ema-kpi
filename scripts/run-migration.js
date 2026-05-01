#!/usr/bin/env node
/* ============================================================
   Migration runner — executes a .sql file against DATABASE_URL.
   Usage:
     node scripts/run-migration.js scripts/2026-05-01-champion-access.sql
   Run locally (with DATABASE_URL exported) or via Railway shell.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/run-migration.js <path-to-sql-file>');
    process.exit(1);
  }
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log(`Running migration: ${fullPath}`);
  console.log('---');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('---');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed — rolled back:');
    console.error(err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
