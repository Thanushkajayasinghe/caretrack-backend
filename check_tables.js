import { pool } from './src/config/db.js';

async function main() {
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('Tables:', r.rows.map(x => x.table_name));

  for (const t of r.rows.map(x => x.table_name)) {
    if (t === 'spatial_ref_sys') continue;
    const count = await pool.query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`  ${t}: ${count.rows[0].count} rows`);
  }
  process.exit(0);
}
main();
