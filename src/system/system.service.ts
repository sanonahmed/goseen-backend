import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export const GOSEEN_USER_ID = '00000000-0000-0000-0000-000000000001';

@Injectable()
export class SystemService implements OnModuleInit {
  private readonly logger = new Logger(SystemService.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    await this.ensureSystemUser();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  private async ensureSystemUser(): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (
         id, email, username, display_name, bio, is_official, is_online
       )
       VALUES (
         $1,
         'system@goseen.app',
         'goseen',
         'GoSeen',
         'The official GoSeen account. Receive welcome messages, security alerts, and app announcements here.',
         TRUE,
         FALSE
       )
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         bio          = EXCLUDED.bio,
         is_official  = TRUE`,
      [GOSEEN_USER_ID],
    );
    this.logger.log('GoSeen system user ready');
  }

  // ── Chat management ───────────────────────────────────────────────────────

  /** Returns the ID of the personal DM between GoSeen and the given user,
   *  creating it if it doesn't exist yet. */
  async getOrCreateGoSeenDm(userId: string): Promise<string> {
    const { rows: existing } = await this.pool.query<{ id: string }>(
      `SELECT c.id FROM chats c
       JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'personal'
       LIMIT 1`,
      [GOSEEN_USER_ID, userId],
    );
    if (existing[0]) return existing[0].id;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO chats (type) VALUES ('personal') RETURNING id`,
      );
      const chatId = rows[0].id;
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [chatId, GOSEEN_USER_ID, userId],
      );
      await client.query('COMMIT');
      return chatId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  private async insertGoSeenMessage(userId: string, text: string): Promise<void> {
    const chatId = await this.getOrCreateGoSeenDm(userId);
    await this.pool.query(
      `WITH ins AS (
         INSERT INTO messages (chat_id, sender_id, type, text)
         VALUES ($1, $2, 'text', $3)
         RETURNING id
       )
       UPDATE chats
       SET last_message_id = (SELECT id FROM ins),
           last_message_at = NOW(),
           updated_at      = NOW()
       WHERE id = $1`,
      [chatId, GOSEEN_USER_ID, text],
    );
    // Increment unread for the recipient (not for GoSeen itself)
    await this.pool.query(
      `UPDATE chat_members
       SET unread_count = unread_count + 1
       WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId],
    );
  }

  /**
   * Send a welcome message to a newly set-up user.
   * Idempotent — silently skips if the GoSeen DM already contains messages,
   * preventing double-sends on repeated profile-setup calls.
   */
  async sendWelcomeMessage(userId: string): Promise<void> {
    try {
      const chatId = await this.getOrCreateGoSeenDm(userId);

      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = $1`,
        [chatId],
      );
      if (Number(rows[0]?.count) > 0) return;

      const { rows: u } = await this.pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
      );
      const name = u[0]?.display_name ?? 'there';

      const text = [
        `👋 Welcome to GoSeen, ${name}!`,
        '',
        "We're thrilled to have you here. GoSeen lets you connect, chat, and share with the people who matter most.",
        '',
        '🔒 Your account is secured with one-time passcodes — no password to remember.',
        '💬 Search for friends, start a conversation, or create a group.',
        '📣 Check back here for announcements, tips, and important updates.',
        '',
        'Enjoy GoSeen! 🚀',
      ].join('\n');

      await this.insertGoSeenMessage(userId, text);
    } catch (err) {
      this.logger.error('sendWelcomeMessage failed', err);
    }
  }

  /**
   * Send a login-security alert to a returning user.
   */
  async sendLoginAlert(userId: string, time: string): Promise<void> {
    try {
      const text = [
        '🔐 New sign-in to your GoSeen account',
        '',
        `Time: ${time}`,
        '',
        "If this was you, no action is needed. If you didn't sign in, your account may be compromised — please contact support immediately.",
      ].join('\n');

      await this.insertGoSeenMessage(userId, text);
    } catch (err) {
      this.logger.error('sendLoginAlert failed', err);
    }
  }

  /**
   * Broadcast an announcement to every user's GoSeen DM.
   * Runs in batches of 50 to stay within DB connection limits.
   * Returns the number of users successfully messaged.
   */
  async broadcastAnnouncement(text: string): Promise<{ sentTo: number }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id != $1 AND email NOT LIKE '%@goseen.app'`,
      [GOSEEN_USER_ID],
    );

    let sentTo = 0;
    const batchSize = 50;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((r) => this.insertGoSeenMessage(r.id, text)),
      );
      sentTo += results.filter((r) => r.status === 'fulfilled').length;
    }
    this.logger.log(`Broadcast sent to ${sentTo}/${rows.length} users`);
    return { sentTo };
  }
}
