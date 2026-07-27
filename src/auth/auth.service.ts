import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { DB_POOL } from '../database/database.module';
import { SystemService } from '../system/system.service';

interface DbUser {
  id: string;
  email: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  otp_code: string | null;
  otp_expires_at: Date | null;
  otp_request_count: number;
  otp_blocked_until: Date | null;
  refresh_token_hash: string | null;
  deletion_requested_at: Date | null;
}

interface DeviceSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  platform: string | null;
  device_name: string | null;
  ip_address: string | null;
  last_active_at: Date;
  created_at: Date;
}

interface DeviceInfo {
  platform?: string;
  deviceName?: string;
  ip?: string;
  sessionId?: string;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private deletionSweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly system: SystemService,
  ) {}

  // How many consecutive un-verified OTP requests trigger the 1-hour block.
  private static readonly OTP_BLOCK_AFTER    = 5;
  private static readonly OTP_BLOCK_DURATION = 60 * 60_000; // 1 hour in ms
  private static readonly OTP_COOLDOWN_SECS  = 60;

  // Grace period between an account-deletion request and it actually being purged.
  private static readonly DELETION_GRACE_DAYS = 7;
  private static readonly DELETION_SWEEP_INTERVAL_MS = 60 * 60_000; // hourly

  onModuleInit() {
    // Run once at boot (catches accounts whose grace period elapsed while the
    // server was offline — no separate cron dyno on Railway), then hourly.
    this.processScheduledDeletions().catch((err) =>
      this.logger.error('processScheduledDeletions failed', err),
    );
    this.deletionSweepTimer = setInterval(() => {
      this.processScheduledDeletions().catch((err) =>
        this.logger.error('processScheduledDeletions failed', err),
      );
    }, AuthService.DELETION_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.deletionSweepTimer) clearInterval(this.deletionSweepTimer);
  }

  async sendOtp(email: string): Promise<void> {
    const now = Date.now();

    // ── Check rate-limit state for this email ─────────────────────────────────
    const { rows } = await this.pool.query<{
      otp_expires_at:    Date | null;
      otp_request_count: number;
      otp_blocked_until: Date | null;
    }>(
      'SELECT otp_expires_at, otp_request_count, otp_blocked_until FROM users WHERE email = $1',
      [email],
    );
    const existing = rows[0];

    if (existing) {
      // 1. Hard block: too many consecutive requests without a successful verify.
      if (existing.otp_blocked_until && now < new Date(existing.otp_blocked_until).getTime()) {
        const minsLeft = Math.ceil(
          (new Date(existing.otp_blocked_until).getTime() - now) / 60_000,
        );
        throw new HttpException(
          `Too many code requests. Try again in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 2. Per-request 60-second cooldown between sends.
      // otp_expires_at = sentAt + 10 min, so sentAt = otp_expires_at - 10 min.
      if (existing.otp_expires_at) {
        const sentAt  = new Date(existing.otp_expires_at).getTime() - 10 * 60_000;
        const secsAgo = (now - sentAt) / 1_000;
        if (secsAgo < AuthService.OTP_COOLDOWN_SECS) {
          const waitSecs = Math.ceil(AuthService.OTP_COOLDOWN_SECS - secsAgo);
          throw new HttpException(
            `Please wait ${waitSecs} second${waitSecs !== 1 ? 's' : ''} before requesting another code.`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    }

    // ── Compute new request count ─────────────────────────────────────────────
    // If a previous block has expired by time (not by verify), restart the count
    // from zero so the user gets a fresh window after serving their penalty.
    const blockExpired =
      !!existing?.otp_blocked_until &&
      now >= new Date(existing.otp_blocked_until).getTime();
    const prevCount = blockExpired ? 0 : (existing?.otp_request_count ?? 0);
    const newCount  = prevCount + 1;

    // On the 5th consecutive request, set the 1-hour block.
    // The user still receives this last code — subsequent attempts are rejected.
    const blockedUntil =
      newCount >= AuthService.OTP_BLOCK_AFTER
        ? new Date(now + AuthService.OTP_BLOCK_DURATION)
        : null;

    // ── Generate OTP and persist ──────────────────────────────────────────────
    const otp       = Math.floor(100_000 + Math.random() * 900_000).toString();
    const expiresAt = new Date(now + 10 * 60_000);

    await this.pool.query(
      `INSERT INTO users (email, otp_code, otp_expires_at, otp_request_count, otp_blocked_until)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email)
       DO UPDATE SET otp_code          = $2,
                     otp_expires_at    = $3,
                     otp_request_count = $4,
                     otp_blocked_until = $5,
                     updated_at        = NOW()`,
      [email, otp, expiresAt, newCount, blockedUntil],
    );

    // ── Send email ────────────────────────────────────────────────────────────
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.get('SMTP_PASS')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.get('EMAIL_FROM'),
        to: [email],
        subject: 'Your GoSeen verification code',
        text: `Your code is ${otp}. It expires in 10 minutes.`,
        html: `<p>Your GoSeen code: <strong>${otp}</strong></p><p>Expires in 10 minutes.</p>`,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Email delivery failed (${res.status}): ${body}`);
    }
  }

  async verifyOtp(email: string, otp: string, deviceInfo?: DeviceInfo) {
    const { rows } = await this.pool.query<DbUser>(
      'SELECT * FROM users WHERE email = $1',
      [email],
    );
    const user = rows[0];

    if (!user || user.otp_code !== otp) {
      throw new UnauthorizedException('Invalid OTP');
    }
    if (!user.otp_expires_at || new Date() > user.otp_expires_at) {
      throw new UnauthorizedException('OTP expired');
    }

    // Clear OTP and reset rate-limit counters on successful verification.
    await this.pool.query(
      `UPDATE users
       SET otp_code          = NULL,
           otp_expires_at    = NULL,
           otp_request_count = 0,
           otp_blocked_until = NULL,
           updated_at        = NOW()
       WHERE id = $1`,
      [user.id],
    );

    // Logging back in during the grace period cancels a pending deletion.
    const deletionCancelled = user.deletion_requested_at !== null;
    if (deletionCancelled) {
      await this.pool.query(
        `UPDATE users SET deletion_requested_at = NULL WHERE id = $1`,
        [user.id],
      );
    }

    if (user.display_name) {
      const time = new Date().toLocaleString('en-US', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' UTC';
      this.system.sendLoginAlert(user.id, time).catch(() => {});
    }

    const tokens = await this.issueTokens(user, deviceInfo);
    return { ...tokens, account_deletion_cancelled: deletionCancelled };
  }

  async refreshTokens(refreshToken: string, deviceInfo?: DeviceInfo) {
    let payload: { sub: string; email: string; sid?: string };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Try new device-session path first (tokens with sid)
    if (payload.sid) {
      const { rows } = await this.pool.query<DeviceSessionRow>(
        'SELECT * FROM device_sessions WHERE id = $1 AND user_id = $2',
        [payload.sid, payload.sub],
      );
      if (rows[0]) {
        const valid = await bcrypt.compare(refreshToken, rows[0].refresh_token_hash);
        if (!valid) throw new UnauthorizedException('Refresh token revoked');

        const { rows: userRows } = await this.pool.query<DbUser>(
          'SELECT * FROM users WHERE id = $1',
          [payload.sub],
        );
        if (!userRows[0]) throw new UnauthorizedException();

        return this.issueTokens(userRows[0], { ...deviceInfo, sessionId: payload.sid });
      }
    }

    // Fallback: legacy single-token path
    const { rows } = await this.pool.query<DbUser>(
      'SELECT * FROM users WHERE id = $1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user?.refresh_token_hash) throw new UnauthorizedException();

    const valid = await bcrypt.compare(refreshToken, user.refresh_token_hash);
    if (!valid) throw new UnauthorizedException('Refresh token revoked');

    // Migrate the legacy token to a device session
    return this.issueTokens(user, deviceInfo);
  }

  async setupUsername(userId: string, username: string) {
    const { rows: existing } = await this.pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username],
    );
    if (existing.length > 0) throw new BadRequestException('Username taken');

    const { rows } = await this.pool.query<DbUser>(
      'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [username, userId],
    );
    return this.toPublicUser(rows[0]);
  }

  async setupProfile(userId: string, displayName: string, avatarUrl?: string) {
    const { rows } = await this.pool.query<DbUser>(
      `UPDATE users
       SET display_name = $1,
           avatar_url = COALESCE($2, avatar_url),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [displayName, avatarUrl ?? null, userId],
    );
    this.system.sendWelcomeMessage(userId).catch(() => {});
    return this.toPublicUser(rows[0]);
  }

  async getMe(userId: string) {
    const { rows } = await this.pool.query<DbUser>(
      'SELECT * FROM users WHERE id = $1',
      [userId],
    );
    if (!rows[0]) throw new UnauthorizedException();
    return this.toPublicUser(rows[0]);
  }

  async checkUsernameAvailable(username: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM users WHERE username = $1
       UNION ALL
       SELECT 1 FROM chats WHERE username = $1
       UNION ALL
       SELECT 1 FROM mini_apps WHERE slug = $1
       LIMIT 1`,
      [username],
    );
    return rows.length === 0;
  }

  async logout(userId: string, sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.pool.query(
        'DELETE FROM device_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, userId],
      );
    }
    // Also clear legacy hash
    await this.pool.query(
      'UPDATE users SET refresh_token_hash = NULL WHERE id = $1',
      [userId],
    );
  }

  async getSessions(userId: string, currentSessionId?: string) {
    const { rows } = await this.pool.query<DeviceSessionRow>(
      'SELECT * FROM device_sessions WHERE user_id = $1 ORDER BY last_active_at DESC',
      [userId],
    );
    return rows.map((s) => ({
      id: s.id,
      platform: s.platform ?? 'unknown',
      device_name: s.device_name ?? 'Unknown Device',
      ip_address: s.ip_address ?? null,
      last_active_at: s.last_active_at,
      created_at: s.created_at,
      is_current: s.id === currentSessionId,
    }));
  }

  async terminateSession(userId: string, sessionId: string, currentSessionId?: string): Promise<void> {
    if (sessionId === currentSessionId) {
      throw new BadRequestException('Cannot terminate the current session');
    }
    await this.pool.query(
      'DELETE FROM device_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId],
    );
  }

  async terminateOtherSessions(userId: string, currentSessionId?: string): Promise<void> {
    if (currentSessionId) {
      await this.pool.query(
        'DELETE FROM device_sessions WHERE user_id = $1 AND id != $2',
        [userId, currentSessionId],
      );
    } else {
      await this.pool.query(
        'DELETE FROM device_sessions WHERE user_id = $1',
        [userId],
      );
    }
  }

  // Starts the 7-day deletion grace period: marks the account pending and
  // immediately revokes every active session (this device included — the
  // client is expected to log the user out right after this call). The
  // account itself is untouched otherwise, so a normal OTP login still works
  // and, per verifyOtp() above, cancels the pending deletion.
  async requestAccountDeletion(userId: string): Promise<{ deletionScheduledAt: string }> {
    await this.pool.query(
      `UPDATE users SET deletion_requested_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId],
    );
    await this.pool.query('DELETE FROM device_sessions WHERE user_id = $1', [userId]);
    await this.pool.query('UPDATE users SET refresh_token_hash = NULL WHERE id = $1', [userId]);

    const deletionScheduledAt = new Date(
      Date.now() + AuthService.DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
    return { deletionScheduledAt: deletionScheduledAt.toISOString() };
  }

  // Finds every account whose grace period has elapsed with no cancelling
  // login, and permanently anonymizes them. Run on a timer from onModuleInit.
  async processScheduledDeletions(): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM users
       WHERE deletion_requested_at IS NOT NULL
         AND deletion_requested_at <= NOW() - INTERVAL '${AuthService.DELETION_GRACE_DAYS} days'`,
    );
    for (const row of rows) {
      try {
        await this.finalizeAccountDeletion(row.id);
      } catch (err) {
        this.logger.error(`Failed to finalize deletion for user ${row.id}`, err);
      }
    }
  }

  // Permanently removes the user's identity and social footprint. The `users`
  // row itself is kept (not dropped) because messages, stories, and posts
  // belong to a shared history other people still see — hard-deleting it would
  // cascade-delete every message this user ever sent, wiping other people's
  // chat history too. Instead we scrub PII, revoke all sessions, and strip
  // the account's presence from the social graph.
  private async finalizeAccountDeletion(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE users SET
           email                  = $2,
           username               = NULL,
           display_name           = 'Deleted User',
           avatar_url             = NULL,
           bio                    = NULL,
           fcm_token              = NULL,
           e2ee_public_key        = NULL,
           otp_code               = NULL,
           otp_expires_at         = NULL,
           otp_request_count      = 0,
           otp_blocked_until      = NULL,
           refresh_token_hash     = NULL,
           is_online              = FALSE,
           deletion_requested_at  = NULL,
           deleted_at             = NOW(),
           updated_at             = NOW()
         WHERE id = $1`,
        [userId, `deleted-${userId}@deleted.goseen.app`],
      );

      await client.query('DELETE FROM device_sessions WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM stories WHERE user_id = $1', [userId]);
      await client.query(
        'DELETE FROM connections WHERE follower_id = $1 OR following_id = $1',
        [userId],
      );
      await client.query(
        'DELETE FROM blocked_users WHERE blocker_id = $1 OR blocked_id = $1',
        [userId],
      );
      await client.query('DELETE FROM chat_members WHERE user_id = $1', [userId]);
      await client.query(
        `UPDATE posts SET is_hidden = TRUE WHERE payload->>'authorUid' = $1::text`,
        [userId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async issueTokens(user: DbUser, deviceInfo?: DeviceInfo) {
    let sessionId = deviceInfo?.sessionId;

    if (!sessionId) {
      // Create a placeholder session row to obtain the UUID
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO device_sessions (user_id, refresh_token_hash, platform, device_name, ip_address)
         VALUES ($1, 'placeholder', $2, $3, $4)
         RETURNING id`,
        [
          user.id,
          deviceInfo?.platform ?? null,
          deviceInfo?.deviceName ?? null,
          deviceInfo?.ip ?? null,
        ],
      );
      sessionId = rows[0].id;
    } else {
      // Update existing session's device info and activity timestamp
      await this.pool.query(
        `UPDATE device_sessions
         SET last_active_at = NOW(),
             ip_address = COALESCE($1, ip_address)
         WHERE id = $2`,
        [deviceInfo?.ip ?? null, sessionId],
      );
    }

    const payload = { sub: user.id, email: user.email, sid: sessionId };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_EXPIRES') ?? '15m',
    });

    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES') ?? '30d',
    });

    const hash = await bcrypt.hash(refreshToken, 10);

    await this.pool.query(
      'UPDATE device_sessions SET refresh_token_hash = $1 WHERE id = $2',
      [hash, sessionId],
    );

    // Keep legacy column in sync so old clients that refresh without sid still work
    await this.pool.query(
      'UPDATE users SET refresh_token_hash = $1 WHERE id = $2',
      [hash, user.id],
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: this.toPublicUser(user),
    };
  }

  private toPublicUser(user: DbUser) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
    };
  }
}
