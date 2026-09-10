import 'dotenv/config';
import pg from 'pg';
import knex from 'knex';

const { Pool } = pg;

const isLocal = !process.env.DATABASE_URL || 
  process.env.DATABASE_URL.includes('localhost') || 
  process.env.DATABASE_URL.includes('127.0.0.1');

const ssl = isLocal ? false : { rejectUnauthorized: false };

// Raw pool for simple queries
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Knex query builder
export const db = knex({
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl,
  },
  pool: { min: 2, max: 10 },
  acquireConnectionTimeout: 5000,
});

export async function connectDB() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    throw err;
  }
}
