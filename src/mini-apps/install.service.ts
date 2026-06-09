import {
  Injectable, Inject, NotFoundException,
  ConflictException, ForbiddenException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

@Injectable()
export class InstallService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getInstalled(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT
         mai.id, mai.mini_app_id, mai.granted_permissions, mai.denied_permissions,
         mai.is_pinned, mai.open_count, mai.last_opened_at, mai.installed_at,
         ma.name, ma.slug, ma.icon_url, ma.category, ma.short_description,
         ma.rating_average, ma.total_installs,
         mv.version AS current_version, mv.app_url,
         da.display_name AS developer_name, da.is_verified AS developer_verified
       FROM mini_app_installs mai
       JOIN mini_apps ma ON ma.id = mai.mini_app_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       JOIN developer_accounts da ON da.id = ma.developer_id
       WHERE mai.user_id = $1 AND ma.status = 'published'
       ORDER BY mai.is_pinned DESC, mai.last_opened_at DESC NULLS LAST`,
      [userId],
    );

    return rows.map((r: any) => ({
      installId: r.id,
      miniApp: {
        id: r.mini_app_id,
        slug: r.slug,
        name: r.name,
        iconUrl: r.icon_url,
        category: r.category,
        shortDescription: r.short_description,
        rating: parseFloat(r.rating_average),
        currentVersion: r.current_version,
        appUrl: r.app_url,
        developer: { name: r.developer_name, isVerified: r.developer_verified },
      },
      grantedPermissions: r.granted_permissions,
      deniedPermissions: r.denied_permissions,
      isPinned: r.is_pinned,
      openCount: r.open_count,
      lastOpenedAt: r.last_opened_at,
      installedAt: r.installed_at,
    }));
  }

  async install(userId: string, miniAppId: string) {
    // Verify app exists and is published
    const { rows: appRows } = await this.pool.query(
      `SELECT id, current_version_id FROM mini_apps WHERE id = $1 AND status = 'published'`,
      [miniAppId],
    );
    if (!appRows[0]) throw new NotFoundException('Mini app not found or not published');

    // Upsert install record
    await this.pool.query(
      `INSERT INTO mini_app_installs (user_id, mini_app_id, version_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, mini_app_id) DO NOTHING`,
      [userId, miniAppId, appRows[0].current_version_id],
    );

    // Increment install counter
    await this.pool.query(
      `UPDATE mini_apps
       SET total_installs  = total_installs + 1,
           active_installs = active_installs + 1,
           updated_at      = NOW()
       WHERE id = $1`,
      [miniAppId],
    );

    return { ok: true };
  }

  async uninstall(userId: string, miniAppId: string) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM mini_app_installs WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId],
    );
    if (rowCount === 0) throw new NotFoundException('Install record not found');

    await this.pool.query(
      `UPDATE mini_apps
       SET active_installs = GREATEST(active_installs - 1, 0), updated_at = NOW()
       WHERE id = $1`,
      [miniAppId],
    );

    return { ok: true };
  }

  async updatePermissions(
    userId: string,
    miniAppId: string,
    granted: string[],
    denied: string[],
  ) {
    const { rowCount } = await this.pool.query(
      `UPDATE mini_app_installs
       SET granted_permissions = $3, denied_permissions = $4, updated_at = NOW()
       WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId, granted, denied],
    );
    if (rowCount === 0) throw new NotFoundException('Install record not found');
    return { ok: true };
  }

  async grantSinglePermission(userId: string, miniAppId: string, scope: string) {
    await this.pool.query(
      `UPDATE mini_app_installs
       SET granted_permissions = array_append(
             array_remove(granted_permissions, $3), $3
           ),
           denied_permissions = array_remove(denied_permissions, $3),
           updated_at = NOW()
       WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId, scope],
    );
    return { ok: true };
  }

  async recordOpen(userId: string, miniAppId: string) {
    await this.pool.query(
      `UPDATE mini_app_installs
       SET open_count = open_count + 1, last_opened_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId],
    );
  }

  async getInstallRecord(userId: string, miniAppId: string) {
    const { rows } = await this.pool.query(
      `SELECT granted_permissions, denied_permissions, is_pinned, open_count, last_opened_at
       FROM mini_app_installs
       WHERE user_id = $1 AND mini_app_id = $2`,
      [userId, miniAppId],
    );
    return rows[0] ?? null;
  }
}
