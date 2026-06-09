import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException, Inject,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

@Injectable()
export class DeveloperApiKeyGuard implements CanActivate {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const authHeader: string = req.headers?.authorization ?? '';
    const rawKey = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!rawKey || !rawKey.startsWith('gsk_')) {
      throw new UnauthorizedException('Developer API key required (must start with gsk_)');
    }

    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const { rows } = await this.pool.query(
      `SELECT dk.id, dk.developer_id, dk.scopes, da.user_id
       FROM developer_api_keys dk
       JOIN developer_accounts da ON da.id = dk.developer_id
       WHERE dk.key_hash = $1
         AND dk.is_active = TRUE
         AND (dk.expires_at IS NULL OR dk.expires_at > NOW())
         AND da.is_suspended = FALSE`,
      [keyHash],
    );

    if (!rows[0]) throw new UnauthorizedException('Invalid or expired API key');

    // Update last_used_at without blocking the request
    this.pool
      .query(`UPDATE developer_api_keys SET last_used_at = NOW() WHERE id = $1`, [rows[0].id])
      .catch(() => {});

    req.developer = {
      keyId: rows[0].id,
      developerId: rows[0].developer_id,
      userId: rows[0].user_id,
      scopes: rows[0].scopes as string[],
    };
    return true;
  }
}
