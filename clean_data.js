import { pool } from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function cleanData() {
  console.log('--- Cleaning CareTrack Database Data ---');
  
  // 1. Delete location history
  const locRes = await pool.query('DELETE FROM locations');
  console.log(`Deleted ${locRes.rowCount} locations.`);

  // 2. Delete pairing sessions
  const pairRes = await pool.query('DELETE FROM pairing_sessions');
  console.log(`Deleted ${pairRes.rowCount} pairing sessions.`);

  // 3. Delete child devices
  const devRes = await pool.query('DELETE FROM child_devices');
  console.log(`Deleted ${devRes.rowCount} child devices.`);

  // 4. Delete children
  const childRes = await pool.query('DELETE FROM children');
  console.log(`Deleted ${childRes.rowCount} children.`);

  // 5. Delete refresh tokens
  const tokenRes = await pool.query('DELETE FROM refresh_tokens');
  console.log(`Deleted ${tokenRes.rowCount} refresh tokens.`);

  // 6. Ensure Thanushka's account exists with password 'secret123'
  const hash = await bcrypt.hash('secret123', 10);
  await pool.query(
    `UPDATE parents SET password_hash = $1 WHERE email = 'thanushkajayasinghe@gmail.com'`,
    [hash]
  );
  console.log(`Reset password for thanushkajayasinghe@gmail.com to 'secret123'.`);

  console.log('--- Database Cleanup Completed Successfully ---');
  process.exit(0);
}

cleanData().catch((err) => {
  console.error('Error during cleanup:', err);
  process.exit(1);
});
