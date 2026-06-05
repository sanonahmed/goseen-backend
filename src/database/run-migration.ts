import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { INITIAL_SCHEMA, DROP_SCHEMA } from './schema';

dotenv.config(); // no-op on Railway (env already set), needed for local dev

async function needsReset(pool: Pool): Promise<boolean> {
  // If RESET_DB is explicitly set, always reset
  if (process.env.RESET_DB === 'true') {
    console.log('[migration] RESET_DB=true — forcing schema reset');
    return true;
  }

  // Check if the chats table exists with a wrong id type (TEXT instead of UUID).
  // This happens when a previous deployment created tables with incorrect types.
  const { rows } = await pool.query<{ data_type: string }>(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'chats'
      AND column_name  = 'id'
  `);

  if (rows.length > 0 && rows[0].data_type !== 'uuid') {
    console.log(
      `[migration] Detected stale schema: chats.id is "${rows[0].data_type}", expected "uuid". Resetting.`,
    );
    return true;
  }

  return false;
}

export async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    if (await needsReset(pool)) {
      await pool.query(DROP_SCHEMA);
      console.log('[migration] Existing tables dropped');
    }

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
