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
import * as nodemailer from 'nodemailer';
import { DB_POOL } from '../database/database.module';

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

@Injectable()
export class AuthService {
  private mailer: nodemailer.Transporter;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    const port = Number(config.get('SMTP_PORT') ?? 587);
    this.mailer = nodemailer.createTransport({
      host: config.get('SMTP_HOST'),
      port,
      secure: port === 465, // SSL for Resend port 465, STARTTLS for 587
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
      auth: {
        user: config.get('SMTP_USER'),
        pass: config.get('SMTP_PASS'),
      },
    });
  }

  async sendOtp(email: string): Promise<void> {
    const otp = Math.floor(100_000 + Math.random() * 900_000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000); // 10 min

    await this.pool.query(
      `INSERT INTO users (email, otp_code, otp_expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email)
       DO UPDATE SET otp_code = $2, otp_expires_at = $3, updated_at = NOW()`,
      [email, otp, expiresAt],
    );

    await this.mailer.sendMail({
      from: this.config.get('EMAIL_FROM'),
      to: email,
      subject: 'Your GoSeen verification code',
      text: `Your code is ${otp}. It expires in 10 minutes.`,
      html: `<p>Your GoSeen code: <strong>${otp}</strong></p><p>Expires in 10 minutes.</p>`,
    });
  }

  async verifyOtp(email: string, otp: string) {
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

    return this.issueTokens(user);
  }

  async refreshTokens(refreshToken: string) {
    let payload: { sub: string; email: string };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const { rows } = await this.pool.query<DbUser>(
      'SELECT * FROM users WHERE id = $1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user?.refresh_token_hash) throw new UnauthorizedException();

    const valid = await bcrypt.compare(refreshToken, user.refresh_token_hash);
    if (!valid) throw new UnauthorizedException('Refresh token revoked');

    return this.issueTokens(user);
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

  async setupProfile(
    userId: string,
    displayName: string,
    avatarUrl?: string,
  ) {
    const { rows } = await this.pool.query<DbUser>(
      `UPDATE users
       SET display_name = $1,
           avatar_url = COALESCE($2, avatar_url),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [displayName, avatarUrl ?? null, userId],
    );
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
      'SELECT id FROM users WHERE username = $1',
      [username],
    );
    return rows.length === 0;
  }

  async logout(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET refresh_token_hash = NULL WHERE id = $1',
      [userId],
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async issueTokens(user: DbUser) {
    const payload = { sub: user.id, email: user.email };

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
