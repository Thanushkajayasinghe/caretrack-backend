import { pool } from './src/config/db.js';

async function update() {
  await pool.query("UPDATE parents SET email = 'parent@caretrack.co'");
  console.log('SUCCESS: updated email to parent@caretrack.co');
  process.exit(0);
}
update();
