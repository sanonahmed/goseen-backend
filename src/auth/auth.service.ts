import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Inject,
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
  refresh_token_hash: string | null;
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
export class AuthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly system: SystemService,
  ) {}

  async sendOtp(email: string): Promise<void> {
    const otp = Math.floor(100_000 + Math.random() * 900_000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000);

    await this.pool.query(
      `INSERT INTO users (email, otp_code, otp_expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email)
       DO UPDATE SET otp_code = $2, otp_expires_at = $3, updated_at = NOW()`,
      [email, otp, expiresAt],
    );

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

    await this.pool.query(
      'UPDATE users SET otp_code = NULL, otp_expires_at = NULL, updated_at = NOW() WHERE id = $1',
      [user.id],
    );

    if (user.display_name) {
      const time = new Date().toLocaleString('en-US', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' UTC';
      this.system.sendLoginAlert(user.id, time).catch(() => {});
    }

    return this.issueTokens(user, deviceInfo);
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
