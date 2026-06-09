import { Controller, Get, Param, Res, NotFoundException, Inject } from '@nestjs/common';
import { Response } from 'express';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

@Controller('miniapps/hosted')
export class HostedController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Get(':versionId')
  async serveCode(
    @Param('versionId') versionId: string,
    @Res() res: Response,
  ) {
    const { rows } = await this.pool.query(
      `SELECT content, mime_type FROM mini_app_hosted_code WHERE version_id = $1`,
      [versionId],
    );
    if (!rows[0]) throw new NotFoundException('App not found');

    res.setHeader('Content-Type', (rows[0].mime_type as string) ?? 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader(
      'Content-Security-Policy',
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
    );
    res.send(rows[0].content as string);
  }
}
