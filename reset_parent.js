import { pool } from './src/config/db.js';
import bcrypt from 'bcryptjs';

async function update() {
  const hash = await bcrypt.hash('secret123', 10);
  await pool.query('UPDATE parents SET password_hash = $1 WHERE email = $2', [hash, 'teefee@gmmail.com']);
  console.log('SUCCESS: password set to secret123 for teefee@gmmail.com');
  process.exit(0);
}
update();
