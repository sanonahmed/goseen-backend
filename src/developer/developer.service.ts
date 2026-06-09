import {
  Injectable, Inject, NotFoundException,
  ConflictException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { createHash, randomBytes } from 'crypto';
import { RegisterDeveloperDto } from './dto/register-developer.dto';
import { CreateAppDto } from './dto/create-app.dto';
import { UpdateAppDto } from './dto/update-app.dto';
import { SubmitVersionDto } from './dto/submit-version.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Injectable()
export class DeveloperService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  // ── Developer Account ─────────────────────────────────────────────────────

  async register(userId: string, dto: RegisterDeveloperDto) {
    const { rows } = await this.pool.query(
      `INSERT INTO developer_accounts (user_id, display_name, website_url, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [userId, dto.displayName, dto.websiteUrl ?? null, dto.description ?? null],
    );
    if (!rows[0]) throw new ConflictException('Developer account already exists for this user');
    return { id: rows[0].id };
  }

  async getAccount(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, display_name, website_url, description, avatar_url,
              is_verified, is_suspended, total_installs, created_at
       FROM developer_accounts WHERE user_id = $1`,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException('Developer account not found');
    return rows[0];
  }

  // ── Apps ──────────────────────────────────────────────────────────────────

  async createApp(userId: string, dto: CreateAppDto) {
    const dev = await this._requireDeveloper(userId);

    // Check slug uniqueness
    const { rows: existing } = await this.pool.query(
      `SELECT 1 FROM mini_apps WHERE slug = $1`,
      [dto.slug],
    );
    if (existing.length) throw new ConflictException(`Slug "${dto.slug}" is already taken`);

    const { rows } = await this.pool.query(
      `INSERT INTO mini_apps
         (developer_id, name, slug, short_description, description, category,
          tags, privacy_policy_url, terms_url, support_url, contact_email, allowed_domains)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, slug`,
      [
        dev.id,
        dto.name, dto.slug, dto.shortDescription, dto.description,
        dto.category, dto.tags ?? [],
        dto.privacyPolicyUrl ?? null, dto.termsUrl ?? null,
        dto.supportUrl ?? null, dto.contactEmail ?? null,
        dto.allowedDomains ?? [],
      ],
    );
    return { id: rows[0].id, slug: rows[0].slug };
  }

  async getMyApps(userId: string) {
    const dev = await this._requireDeveloper(userId);
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.icon_url,
         ma.category, ma.status, ma.total_installs, ma.active_installs,
         ma.rating_average, ma.rating_count, ma.created_at, ma.updated_at,
         mv.version AS current_version
       FROM mini_apps ma
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.developer_id = $1
       ORDER BY ma.created_at DESC`,
      [dev.id],
    );
    return rows;
  }

  async getApp(userId: string, appId: string) {
    const dev = await this._requireDeveloper(userId);
    const { rows } = await this.pool.query(
      `SELECT
         ma.id, ma.slug, ma.name, ma.short_description, ma.description,
         ma.icon_url, ma.banner_url, ma.category, ma.tags, ma.status,
         ma.total_installs, ma.active_installs, ma.rating_average, ma.rating_count,
         ma.privacy_policy_url, ma.terms_url, ma.support_url, ma.contact_email,
         ma.allowed_domains, ma.is_featured, ma.created_at, ma.updated_at,
         mv.version AS current_version, mv.app_url, mv.status AS version_status
       FROM mini_apps ma
       LEFT JOIN mini_app_versions mv ON mv.id = ma.current_version_id
       WHERE ma.id = $1 AND ma.developer_id = $2`,
      [appId, dev.id],
    );
    if (!rows[0]) throw new NotFoundException('App not found');
    return rows[0];
  }

  async updateApp(userId: string, appId: string, dto: UpdateAppDto) {
    const dev = await this._requireDeveloper(userId);
    await this._requireAppOwnership(dev.id, appId);

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const map: Record<string, unknown> = {
      name: dto.name,
      short_description: dto.shortDescription,
      description: dto.description,
      category: dto.category,
      tags: dto.tags,
      privacy_policy_url: dto.privacyPolicyUrl,
      terms_url: dto.termsUrl,
      support_url: dto.supportUrl,
      contact_email: dto.contactEmail,
      allowed_domains: dto.allowedDomains,
      icon_url: dto.iconUrl,
      banner_url: dto.bannerUrl,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    }
    if (fields.length === 0) return this.getApp(userId, appId);

    values.push(appId);
    await this.pool.query(
      `UPDATE mini_apps SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      values,
    );
    return this.getApp(userId, appId);
  }

  // ── Versions ──────────────────────────────────────────────────────────────

  async getVersions(userId: string, appId: string) {
    const dev = await this._requireDeveloper(userId);
    await this._requireAppOwnership(dev.id, appId);

    const { rows } = await this.pool.query(
      `SELECT id, version, app_url, status, rejection_reason,
              changelog, screenshots, submitted_at, reviewed_at, published_at, created_at
       FROM mini_app_versions
       WHERE mini_app_id = $1
       ORDER BY created_at DESC`,
      [appId],
    );
    return rows;
  }

  async submitVersion(userId: string, appId: string, dto: SubmitVersionDto) {
    const dev = await this._requireDeveloper(userId);
    await this._requireAppOwnership(dev.id, appId);

    // Must have privacy policy and terms before submitting
    const { rows: appRows } = await this.pool.query(
      `SELECT privacy_policy_url, terms_url FROM mini_apps WHERE id = $1`,
      [appId],
    );
    if (!appRows[0].privacy_policy_url || !appRows[0].terms_url) {
      throw new BadRequestException(
        'App must have privacy_policy_url and terms_url set before submitting a version',
      );
    }

    // Create the version record
    const { rows } = await this.pool.query(
      `INSERT INTO mini_app_versions
         (mini_app_id, version, app_url, changelog, min_goseen_version, screenshots, status, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_review', NOW())
       RETURNING id`,
      [
        appId, dto.version, dto.appUrl,
        dto.changelog ?? null, dto.minGoseenVersion ?? null,
        JSON.stringify(dto.screenshots ?? []),
      ],
    );
    const versionId = rows[0].id;

    // Create review queue entry
    await this.pool.query(
      `INSERT INTO app_review_queue (version_id, mini_app_id) VALUES ($1, $2)`,
      [versionId, appId],
    );

    // Update app status to pending_review
    await this.pool.query(
      `UPDATE mini_apps SET status = 'pending_review', updated_at = NOW() WHERE id = $1`,
      [appId],
    );

    console.log(`[Developer] version submitted app=${appId} version=${dto.version}`);
    return { id: versionId, status: 'pending_review' };
  }

  // ── API Keys ──────────────────────────────────────────────────────────────

  async getApiKeys(userId: string) {
    const dev = await this._requireDeveloper(userId);
    const { rows } = await this.pool.query(
      `SELECT id, name, key_prefix, last_four, scopes, is_active, expires_at, last_used_at, created_at
       FROM developer_api_keys
       WHERE developer_id = $1
       ORDER BY created_at DESC`,
      [dev.id],
    );
    return rows;
  }

  async generateApiKey(userId: string, dto: CreateApiKeyDto) {
    const dev = await this._requireDeveloper(userId);

    // Format: gsk_{env}_{40 random hex chars}
    const randomPart = randomBytes(20).toString('hex');
    const rawKey = `gsk_live_${randomPart}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 12); // "gsk_live_xxxx" first 12 chars
    const lastFour = rawKey.slice(-4);

    const { rows } = await this.pool.query(
      `INSERT INTO developer_api_keys
         (developer_id, name, key_prefix, key_hash, last_four, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        dev.id, dto.name, keyPrefix, keyHash, lastFour,
        dto.scopes ?? ['read', 'verify'],
        dto.expiresAt ? new Date(dto.expiresAt) : null,
      ],
    );

    // Return the raw key ONCE — it will never be shown again
    return {
      id: rows[0].id,
      key: rawKey,        // show once
      keyPrefix,
      lastFour,
      name: dto.name,
      scopes: dto.scopes ?? ['read', 'verify'],
    };
  }

  async revokeApiKey(userId: string, keyId: string) {
    const dev = await this._requireDeveloper(userId);
    const { rowCount } = await this.pool.query(
      `UPDATE developer_api_keys SET is_active = FALSE
       WHERE id = $1 AND developer_id = $2`,
      [keyId, dev.id],
    );
    if (rowCount === 0) throw new NotFoundException('API key not found');
    return { ok: true };
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async getAnalytics(userId: string, appId: string, range: '7d' | '30d' | '90d' = '30d') {
    const dev = await this._requireDeveloper(userId);
    await this._requireAppOwnership(dev.id, appId);

    const intervalMap = { '7d': '7 days', '30d': '30 days', '90d': '90 days' };
    const interval = intervalMap[range] ?? '30 days';

    const [dailyRows, apiRows, permRows] = await Promise.all([
      // Daily opens and unique users
      this.pool.query(
        `SELECT
           DATE(created_at) AS day,
           COUNT(*) FILTER (WHERE event_type = 'app_open') AS opens,
           COUNT(DISTINCT user_id) FILTER (WHERE event_type = 'app_open') AS unique_users,
           AVG(duration_ms) FILTER (WHERE event_type = 'app_close') AS avg_session_ms
         FROM analytics_events
         WHERE mini_app_id = $1
           AND created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY DATE(created_at)
         ORDER BY day`,
        [appId],
      ),
      // API method breakdown
      this.pool.query(
        `SELECT event_data->>'method' AS method, COUNT(*) AS calls
         FROM analytics_events
         WHERE mini_app_id = $1
           AND event_type = 'api_call'
           AND created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY event_data->>'method'
         ORDER BY calls DESC`,
        [appId],
      ),
      // Permission approval/denial breakdown
      this.pool.query(
        `SELECT
           event_data->>'scope' AS scope,
           COUNT(*) FILTER (WHERE event_type = 'permission_granted') AS granted,
           COUNT(*) FILTER (WHERE event_type = 'permission_denied') AS denied
         FROM analytics_events
         WHERE mini_app_id = $1
           AND event_type IN ('permission_granted', 'permission_denied')
           AND created_at >= NOW() - INTERVAL '${interval}'
         GROUP BY event_data->>'scope'`,
        [appId],
      ),
    ]);

    return {
      daily: dailyRows.rows.map((r: any) => ({
        day: r.day,
        opens: parseInt(r.opens, 10),
        uniqueUsers: parseInt(r.unique_users, 10),
        avgSessionMs: r.avg_session_ms ? parseFloat(r.avg_session_ms) : null,
      })),
      apiCalls: apiRows.rows.map((r: any) => ({
        method: r.method,
        calls: parseInt(r.calls, 10),
      })),
      permissions: permRows.rows.map((r: any) => ({
        scope: r.scope,
        granted: parseInt(r.granted, 10),
        denied: parseInt(r.denied, 10),
      })),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _requireDeveloper(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id FROM developer_accounts WHERE user_id = $1 AND is_suspended = FALSE`,
      [userId],
    );
    if (!rows[0]) throw new ForbiddenException('Developer account required. Register at /api/v1/developer/register');
    return rows[0] as { id: string };
  }

  private async _requireAppOwnership(developerId: string, appId: string) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM mini_apps WHERE id = $1 AND developer_id = $2`,
      [appId, developerId],
    );
    if (!rows[0]) throw new ForbiddenException('App not found or access denied');
  }
}
