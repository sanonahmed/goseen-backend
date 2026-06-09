import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { StoreQueryDto } from './dto/store-query.dto';

@Injectable()
export class StoreService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getListing(query: StoreQueryDto, userId?: string) {
    const { q, category, sort = 'trending', tag, page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;
    const conditions: string[] = [`ma.status = 'published'`];
    const params: unknown[] = [];
    let idx = 1;

    if (q) {
      conditions.push(
        `(ma.name ILIKE $${idx} OR ma.short_description ILIKE $${idx} OR to_tsvector('english', ma.name || ' ' || ma.short_description) @@ plainto_tsquery('english', $${idx + 1}))`,
      );
      params.push(`%${q}%`, q);
      idx += 2;
    }
    if (category) {
      conditions.push(`ma.category = $${idx++}`);
      params.push(category);
    }
    if (tag) {
      conditions.push(`$${idx++} = ANY(ma.tags)`);
      params.push(tag);
    }

    const orderMap: Record<string, string> = {
      trending: 'ma.trending_score DESC',
      rating: 'ma.rating_average DESC, ma.rating_count DESC',
      installs: 'ma.total_installs DESC',
      recent: 'ma.updated_at DESC',
    };
    const orderBy = orderMap[sort] ?? orderMap.trending;

    const where = conditions.join(' AND ');

    const countParams = [...params];
    const { rows: countRows } = await this.pool.query(
      `SELECT COUNT(*) FROM mini_apps ma WHERE ${where}`,
      countParams,
    );
    const total = parseInt(countRows[0].count, 10);

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.icon_url,
         ma.banner_url, ma.category, ma.tags, ma.total_installs,
         ma.rating_average, ma.rating_count, ma.is_featured,
         ma.updated_at,
         da.display_name AS developer_name, da.is_verified AS developer_verified,
         mv.version AS current_version, mv.app_url
       FROM mini_apps ma
       JOIN developer_accounts da ON da.id = ma.developer_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx++} OFFSET $${idx++}`,
      params,
    );

    const isInstalledMap = await this._getInstalledMap(rows.map((r: any) => r.id), userId);

    return {
      apps: rows.map((r: any) => this._formatApp(r, isInstalledMap)),
      total,
      page,
      limit,
    };
  }

  async getFeatured(userId?: string) {
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.icon_url,
         ma.banner_url, ma.category, ma.tags, ma.total_installs,
         ma.rating_average, ma.rating_count,
         da.display_name AS developer_name, da.is_verified AS developer_verified,
         mv.version AS current_version
       FROM mini_apps ma
       JOIN developer_accounts da ON da.id = ma.developer_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.status = 'published' AND ma.is_featured = TRUE
       ORDER BY ma.featured_order ASC NULLS LAST
       LIMIT 10`,
    );
    const isInstalledMap = await this._getInstalledMap(rows.map((r: any) => r.id), userId);
    return rows.map((r: any) => this._formatApp(r, isInstalledMap));
  }

  async getTrending(userId?: string) {
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.icon_url,
         ma.category, ma.total_installs, ma.rating_average, ma.rating_count,
         da.display_name AS developer_name, da.is_verified AS developer_verified,
         mv.version AS current_version
       FROM mini_apps ma
       JOIN developer_accounts da ON da.id = ma.developer_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.status = 'published'
       ORDER BY ma.trending_score DESC
       LIMIT 20`,
    );
    const isInstalledMap = await this._getInstalledMap(rows.map((r: any) => r.id), userId);
    return rows.map((r: any) => this._formatApp(r, isInstalledMap));
  }

  async getNew(userId?: string) {
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.icon_url,
         ma.category, ma.total_installs, ma.rating_average, ma.rating_count,
         da.display_name AS developer_name, da.is_verified AS developer_verified,
         mv.version AS current_version
       FROM mini_apps ma
       JOIN developer_accounts da ON da.id = ma.developer_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.status = 'published'
         AND mv.published_at > NOW() - INTERVAL '30 days'
       ORDER BY mv.published_at DESC
       LIMIT 20`,
    );
    const isInstalledMap = await this._getInstalledMap(rows.map((r: any) => r.id), userId);
    return rows.map((r: any) => this._formatApp(r, isInstalledMap));
  }

  async getCategories() {
    const { rows } = await this.pool.query(
      `SELECT category, COUNT(*) AS count
       FROM mini_apps
       WHERE status = 'published'
       GROUP BY category
       ORDER BY count DESC`,
    );
    return rows.map((r: any) => ({ category: r.category, count: parseInt(r.count, 10) }));
  }

  async getBySlug(slug: string, userId?: string) {
    // Allow the app's own developer to view their app regardless of status
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.description,
         ma.icon_url, ma.banner_url, ma.category, ma.tags,
         ma.total_installs, ma.active_installs, ma.rating_average, ma.rating_count,
         ma.privacy_policy_url, ma.terms_url, ma.support_url, ma.contact_email,
         ma.allowed_domains, ma.status, ma.created_at, ma.updated_at,
         da.id AS developer_id, da.display_name AS developer_name,
         da.website_url AS developer_website, da.is_verified AS developer_verified,
         mv.id AS version_id, mv.version AS current_version,
         mv.app_url, mv.changelog, mv.screenshots, mv.published_at
       FROM mini_apps ma
       JOIN developer_accounts da ON da.id = ma.developer_id
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.slug = $1
         AND (
           ma.status = 'published'
           OR (
             $2 IS NOT NULL
             AND da.user_id = $2
           )
         )`,
      [slug, userId ?? null],
    );
    if (!rows[0]) throw new NotFoundException('Mini app not found');

    const app = rows[0];

    // Fetch declared permissions
    const { rows: perms } = await this.pool.query(
      `SELECT scope, reason, is_required FROM mini_app_permissions WHERE mini_app_id = $1`,
      [app.id],
    );

    // Fetch install record if user is logged in
    let install: any = null;
    if (userId) {
      const { rows: instRows } = await this.pool.query(
        `SELECT granted_permissions, denied_permissions, is_pinned, open_count, last_opened_at
         FROM mini_app_installs
         WHERE user_id = $1 AND mini_app_id = $2`,
        [userId, app.id],
      );
      install = instRows[0] ?? null;
    }

    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      shortDescription: app.short_description,
      description: app.description,
      iconUrl: app.icon_url,
      bannerUrl: app.banner_url,
      category: app.category,
      tags: app.tags,
      totalInstalls: app.total_installs,
      activeInstalls: app.active_installs,
      rating: { average: parseFloat(app.rating_average), count: app.rating_count },
      privacyPolicyUrl: app.privacy_policy_url,
      termsUrl: app.terms_url,
      supportUrl: app.support_url,
      developer: {
        id: app.developer_id,
        name: app.developer_name,
        website: app.developer_website,
        isVerified: app.developer_verified,
      },
      currentVersion: {
        id: app.version_id,
        version: app.current_version,
        appUrl: app.app_url,
        changelog: app.changelog,
        screenshots: app.screenshots ?? [],
        publishedAt: app.published_at,
      },
      allowedDomains: app.allowed_domains,
      permissions: perms.map((p: any) => ({
        scope: p.scope,
        reason: p.reason,
        isRequired: p.is_required,
      })),
      isInstalled: !!install,
      install: install
        ? {
            grantedPermissions: install.granted_permissions,
            deniedPermissions: install.denied_permissions,
            isPinned: install.is_pinned,
            openCount: install.open_count,
            lastOpenedAt: install.last_opened_at,
          }
        : null,
    };
  }

  async getReviews(miniAppId: string, page = 1, limit = 20, ratingFilter?: number) {
    const offset = (page - 1) * limit;
    const conditions = ['r.mini_app_id = $1', 'r.is_hidden = FALSE'];
    const params: unknown[] = [miniAppId];
    let idx = 2;

    if (ratingFilter) {
      conditions.push(`r.rating = $${idx++}`);
      params.push(ratingFilter);
    }

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT
         r.id, r.rating, r.review_text, r.version_reviewed,
         r.developer_reply, r.developer_replied_at, r.helpful_count,
         r.created_at, r.updated_at,
         u.id AS user_id, u.username, u.display_name, u.avatar_url
       FROM mini_app_reviews r
       JOIN users u ON u.id = r.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.helpful_count DESC, r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params,
    );

    return rows.map((r: any) => ({
      id: r.id,
      rating: r.rating,
      reviewText: r.review_text,
      versionReviewed: r.version_reviewed,
      developerReply: r.developer_reply,
      developerRepliedAt: r.developer_replied_at,
      helpfulCount: r.helpful_count,
      createdAt: r.created_at,
      user: {
        id: r.user_id,
        username: r.username,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      },
    }));
  }

  async submitReview(
    userId: string,
    miniAppId: string,
    rating: number,
    reviewText?: string,
    versionReviewed?: string,
  ) {
    const { rows } = await this.pool.query(
      `INSERT INTO mini_app_reviews
         (user_id, mini_app_id, rating, review_text, version_reviewed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, mini_app_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             review_text = EXCLUDED.review_text,
             version_reviewed = EXCLUDED.version_reviewed,
             updated_at = NOW()
       RETURNING id`,
      [userId, miniAppId, rating, reviewText ?? null, versionReviewed ?? null],
    );
    await this._recalcRating(miniAppId);
    return { id: rows[0].id };
  }

  async getReviewsBySlug(slug: string, page: number, limit: number, ratingFilter?: number) {
    const { rows } = await this.pool.query(
      `SELECT id FROM mini_apps WHERE slug = $1 AND status = 'published'`,
      [slug],
    );
    if (!rows[0]) throw new NotFoundException('Mini app not found');
    return this.getReviews(rows[0].id, page, limit, ratingFilter);
  }

  async submitReviewBySlug(
    userId: string,
    slug: string,
    dto: { rating: number; reviewText?: string; versionReviewed?: string },
  ) {
    const { rows } = await this.pool.query(
      `SELECT id FROM mini_apps WHERE slug = $1 AND status = 'published'`,
      [slug],
    );
    if (!rows[0]) throw new NotFoundException('Mini app not found');
    return this.submitReview(userId, rows[0].id, dto.rating, dto.reviewText, dto.versionReviewed);
  }

  private async _recalcRating(miniAppId: string): Promise<void> {
    await this.pool.query(
      `UPDATE mini_apps
       SET rating_average = (
         SELECT COALESCE(AVG(rating), 0) FROM mini_app_reviews
         WHERE mini_app_id = $1 AND is_hidden = FALSE
       ),
       rating_count = (
         SELECT COUNT(*) FROM mini_app_reviews
         WHERE mini_app_id = $1 AND is_hidden = FALSE
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [miniAppId],
    );
  }

  private async _getInstalledMap(
    appIds: string[],
    userId?: string,
  ): Promise<Record<string, boolean>> {
    if (!userId || appIds.length === 0) return {};
    const placeholders = appIds.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await this.pool.query(
      `SELECT mini_app_id FROM mini_app_installs WHERE user_id = $1 AND mini_app_id IN (${placeholders})`,
      [userId, ...appIds],
    );
    return Object.fromEntries(rows.map((r: any) => [r.mini_app_id, true]));
  }

  private _formatApp(r: any, isInstalledMap: Record<string, boolean>) {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      shortDescription: r.short_description,
      iconUrl: r.icon_url,
      bannerUrl: r.banner_url,
      category: r.category,
      tags: r.tags,
      totalInstalls: parseInt(r.total_installs, 10),
      rating: {
        average: parseFloat(r.rating_average),
        count: parseInt(r.rating_count, 10),
      },
      isFeatured: r.is_featured ?? false,
      developer: {
        name: r.developer_name,
        isVerified: r.developer_verified,
      },
      currentVersion: r.current_version ?? null,
      appUrl: r.app_url ?? null,
      isInstalled: isInstalledMap[r.id] ?? false,
    };
  }
}
