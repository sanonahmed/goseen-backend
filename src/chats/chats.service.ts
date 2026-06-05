import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

@Injectable()
export class ChatsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  // ── Chat list ─────────────────────────────────────────────────────────────

  async getChats(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT
         c.id,
         c.type,
         CASE
           WHEN c.type = 'personal' THEN other.display_name
           ELSE c.name
         END AS name,
         CASE
           WHEN c.type = 'personal' THEN other.avatar_url
           ELSE c.avatar_url
         END AS avatar_url,
         m.text          AS last_message,
         m.type          AS last_message_type,
         m.sender_id     AS last_message_sender_id,
         m.created_at    AS last_message_time,
         cm.unread_count,
         cm.is_muted,
         cm.is_pinned,
         CASE
           WHEN c.type = 'personal' THEN other.is_online
           ELSE FALSE
         END AS is_online
       FROM chat_members cm
       JOIN chats c ON c.id = cm.chat_id
       -- For personal chats, get the other participant
       LEFT JOIN chat_members cm2
         ON cm2.chat_id = c.id AND cm2.user_id != $1 AND c.type = 'personal'
       LEFT JOIN users other
         ON other.id = cm2.user_id
       LEFT JOIN messages m
         ON m.id = c.last_message_id AND m.is_deleted = FALSE
       WHERE cm.user_id = $1
       ORDER BY cm.is_pinned DESC, c.last_message_at DESC NULLS LAST`,
      [userId],
    );
    return rows;
  }

  async getChatById(chatId: string, userId: string) {
    await this.assertMember(chatId, userId);

    const { rows } = await this.pool.query(
      `SELECT c.*,
              json_agg(json_build_object(
                'id',           u.id,
                'username',     u.username,
                'display_name', u.display_name,
                'avatar_url',   u.avatar_url,
                'is_online',    u.is_online,
                'role',         cm.role
              )) AS members
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       JOIN users u         ON u.id = cm.user_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [chatId],
    );
    return rows[0];
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createPersonalChat(userId: string, targetUserId: string) {
    // Check if already exists
    const { rows: existing } = await this.pool.query(
      `SELECT c.id FROM chats c
       JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'personal'
       LIMIT 1`,
      [userId, targetUserId],
    );
    if (existing[0]) return { id: existing[0].id };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO chats (type) VALUES ('personal') RETURNING id`,
      );
      const chatId = rows[0].id;
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [chatId, userId, targetUserId],
      );
      await client.query('COMMIT');
      return { id: chatId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createGroup(
    userId: string,
    name: string,
    memberIds: string[],
    description?: string,
    isPublic = false,
    avatarUrl?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO chats (type, name, description, is_public, avatar_url, created_by)
         VALUES ('group', $1, $2, $3, $4, $5) RETURNING id`,
        [name, description ?? null, isPublic, avatarUrl ?? null, userId],
      );
      const chatId = rows[0].id;

      // Creator is owner; all others are members
      const allIds = [userId, ...memberIds.filter((id) => id !== userId)];
      const values = allIds
        .map((id, i) => `($1, $${i + 2}, '${id === userId ? 'owner' : 'member'}')`)
        .join(', ');
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ${values}`,
        [chatId, ...allIds],
      );
      await client.query('COMMIT');
      return { id: chatId, name, type: 'group' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Mark seen ─────────────────────────────────────────────────────────────

  async markSeen(chatId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_members
       SET unread_count = 0, last_read_at = NOW()
       WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId],
    );
  }

  // ── Helper ────────────────────────────────────────────────────────────────

  async assertMember(chatId: string, userId: string): Promise<void> {
    const { rows } = await this.pool.query(
      'SELECT id FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
    if (!rows[0]) throw new ForbiddenException('Not a member of this chat');
  }

  async incrementUnread(chatId: string, exceptUserId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_members
       SET unread_count = unread_count + 1
       WHERE chat_id = $1 AND user_id != $2`,
      [chatId, exceptUserId],
    );
  }

  async updateLastMessage(
    chatId: string,
    messageId: string,
    senderId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE chats
       SET last_message_id = $2, last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [chatId, messageId],
    );
    await this.incrementUnread(chatId, senderId);
  }
}
