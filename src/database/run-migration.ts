import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { INITIAL_SCHEMA } from './schema';

dotenv.config(); // no-op on Railway (env already set), needed for local dev

export async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    await pool.query(INITIAL_SCHEMA);
    console.log('[migration] Schema applied successfully');
  } catch (err) {
    console.error('[migration] Failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
