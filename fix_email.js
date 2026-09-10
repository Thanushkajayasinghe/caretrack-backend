import { pool } from './src/config/db.js';

async function update() {
  await pool.query("UPDATE parents SET email = 'parent@caretrack.com' WHERE email LIKE '%teefee%'");
  console.log('SUCCESS: updated email to parent@caretrack.com');
  process.exit(0);
}
update();
