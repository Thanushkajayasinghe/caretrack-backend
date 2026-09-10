import { pool } from '../config/db.js';

/**
 * Run the full database migration to create all Stage 1 tables.
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enable PostGIS extension
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // ── Parents ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS parents (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email       VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name        VARCHAR(100),
        phone       VARCHAR(30),
        avatar_url  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Refresh tokens ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_id   UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked     BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_parent ON refresh_tokens(parent_id)`);

    // ── Children ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS children (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_id   UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        name        VARCHAR(100) NOT NULL,
        avatar_url  TEXT,
        avatar_color VARCHAR(7) DEFAULT '#6C63FF',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_children_parent ON children(parent_id)`);

    // ── Child devices (hardware-bound) ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS child_devices (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        child_id              UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        device_token_hash     TEXT NOT NULL UNIQUE,
        device_fingerprint_hash TEXT NOT NULL,
        device_name           VARCHAR(150),
        android_version       VARCHAR(20),
        last_seen             TIMESTAMPTZ,
        battery_level         SMALLINT,
        is_charging           BOOLEAN,
        is_active             BOOLEAN DEFAULT TRUE,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE child_devices
      ADD COLUMN IF NOT EXISTS battery_level SMALLINT,
      ADD COLUMN IF NOT EXISTS is_charging BOOLEAN
    `);

    // ── Pairing sessions ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_id   UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        child_id    UUID REFERENCES children(id) ON DELETE SET NULL,
        code_hash   TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        claimed     BOOLEAN DEFAULT FALSE,
        claimed_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Locations ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id            BIGSERIAL PRIMARY KEY,
        child_id      UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        location      GEOMETRY(POINT, 4326) NOT NULL,
        accuracy      FLOAT,
        speed         FLOAT,
        heading       FLOAT,
        altitude      FLOAT,
        battery_level SMALLINT,
        is_charging   BOOLEAN,
        recorded_at   TIMESTAMPTZ NOT NULL,
        synced_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(child_id, recorded_at)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_locations_child_time ON locations(child_id, recorded_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_locations_geom ON locations USING GIST(location)`);

    await client.query('COMMIT');
    console.log('✅ Database migrations completed');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Run directly: node src/db/migrate.js
import { connectDB } from '../config/db.js';
await connectDB();
await runMigrations();
process.exit(0);
