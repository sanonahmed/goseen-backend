import { Controller, Get, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Get()
  async check() {
    const dbOk = await this.pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);

    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'unreachable',
      uptime: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
    };
  }
}
