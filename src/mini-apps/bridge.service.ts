import {
  Injectable, Inject, NotFoundException,
  UnauthorizedException, BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { InitDataService } from './initdata.service';

@Injectable()
export class BridgeService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly initData: InitDataService,
  ) {}

  /**
   * Called by Flutter when a user opens a mini app.
   * Returns a signed initData string to be injected into the WebView.
   */
  async createSession(
    userId: string,
    miniAppId: string,
    startParam?: string,
  ): Promise<{ initData: string }> {
    // Verify app is published
    const { rows: appRows } = await this.pool.query(
      `SELECT id, status FROM mini_apps WHERE id = $1`,
      [miniAppId],
    );
    if (!appRows[0]) throw new NotFoundException('Mini app not found');
    if (appRows[0].status !== 'published') {
      throw new BadRequestException('Mini app is not published');
    }

    // Fetch user info for signing
    const { rows: userRows } = await this.pool.query(
      `SELECT id, username, display_name, avatar_url FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows[0]) throw new NotFoundException('User not found');

    // Fetch granted permissions for this install (empty if not installed)
    const { rows: installRows } = await this.pool.query(
      `SELECT granted_permissions FROM mini_app_installs
       WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId],
    );
    const grantedPermissions: string[] = installRows[0]?.granted_permissions ?? [];

    const signed = this.initData.sign(
      userRows[0],
      miniAppId,
      grantedPermissions,
      startParam,
    );

    return { initData: signed };
  }

  /**
   * Called by a Mini App's own backend to verify that the user is legitimate.
   * Requires a valid developer API key in Authorization header.
   * The API key must belong to the developer who owns the app referenced in initData.
   */
  async verifyInitData(
    rawInitData: string,
    developerApiKeyHash: string,
  ): Promise<{
    valid: true;
    user: { id: string; username: string; displayName: string; avatarUrl: string };
    miniAppId: string;
    grantedPermissions: string[];
  }> {
    // First verify the API key belongs to a developer who owns the referenced app.
    // We do a pre-parse to extract mini_app_id (before consuming the nonce).
    let miniAppId: string;
    try {
      const params = new URLSearchParams(rawInitData);
      miniAppId = params.get('mini_app_id') ?? '';
    } catch {
      throw new UnauthorizedException('Malformed initData');
    }
    if (!miniAppId) throw new UnauthorizedException('Missing mini_app_id in initData');

    // Verify the API key is valid and the developer owns this app
    const { rows: keyRows } = await this.pool.query(
      `SELECT dk.developer_id
       FROM developer_api_keys dk
       JOIN developer_accounts da ON da.id = dk.developer_id
       JOIN mini_apps ma ON ma.developer_id = da.id
       WHERE dk.key_hash = $1
         AND dk.is_active = TRUE
         AND (dk.expires_at IS NULL OR dk.expires_at > NOW())
         AND ma.id = $2`,
      [developerApiKeyHash, miniAppId],
    );
    if (!keyRows[0]) throw new UnauthorizedException('Invalid API key or app ownership mismatch');

    // Update last_used_at
    await this.pool.query(
      `UPDATE developer_api_keys SET last_used_at = NOW() WHERE key_hash = $1`,
      [developerApiKeyHash],
    );

    // Now verify the initData (consumes the nonce)
    const payload = this.initData.verify(rawInitData);
    if (!payload) throw new UnauthorizedException('Invalid or expired initData');

    return {
      valid: true,
      user: {
        id: payload.userId,
        username: payload.username,
        displayName: payload.displayName,
        avatarUrl: payload.avatarUrl,
      },
      miniAppId: payload.miniAppId,
      grantedPermissions: payload.grantedPermissions,
    };
  }

  // ── Sandboxed storage ─────────────────────────────────────────────────────

  async storageGet(userId: string, miniAppId: string, key: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT value FROM mini_app_storage WHERE mini_app_id = $1 AND user_id = $2 AND key = $3`,
      [miniAppId, userId, key],
    );
    return rows[0]?.value ?? null;
  }

  async storageSet(userId: string, miniAppId: string, key: string, value: string): Promise<void> {
    if (value.length > 4096) throw new BadRequestException('Value exceeds 4 KB limit');

    // Enforce max 100 keys per user per app
    const { rows: countRows } = await this.pool.query(
      `SELECT COUNT(*) FROM mini_app_storage WHERE mini_app_id = $1 AND user_id = $2`,
      [miniAppId, userId],
    );
    const count = parseInt(countRows[0].count, 10);

    const { rows: existRows } = await this.pool.query(
      `SELECT 1 FROM mini_app_storage WHERE mini_app_id = $1 AND user_id = $2 AND key = $3`,
      [miniAppId, userId, key],
    );
    const isNew = existRows.length === 0;
    if (isNew && count >= 100) throw new BadRequestException('Storage key limit (100) reached');

    await this.pool.query(
      `INSERT INTO mini_app_storage (mini_app_id, user_id, key, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (mini_app_id, user_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [miniAppId, userId, key, value],
    );
  }

  async storageDelete(userId: string, miniAppId: string, key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM mini_app_storage WHERE mini_app_id = $1 AND user_id = $2 AND key = $3`,
      [miniAppId, userId, key],
    );
  }

  async storageGetAll(userId: string, miniAppId: string): Promise<Record<string, string>> {
    const { rows } = await this.pool.query(
      `SELECT key, value FROM mini_app_storage WHERE mini_app_id = $1 AND user_id = $2`,
      [miniAppId, userId],
    );
    return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  }
}
