import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface ChannelRow {
  id: string;
  type: string;
  name: string;
  avatar_url: string | null;
  username: string | null;
  is_public: boolean;
  description: string | null;
  created_by: string | null;
}

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
         END AS is_online,
         other.id        AS peer_id,
         other.username  AS peer_username,
         other.last_seen AS last_seen
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
    const { rows: memberRows } = await this.pool.query(
      'SELECT id FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
    if (!memberRows[0]) {
      // Allow non-members to view public channels (for preview before joining)
      const { rows: chatRows } = await this.pool.query(
        'SELECT id, type, is_public FROM chats WHERE id = $1',
        [chatId],
      );
      if (!chatRows[0]) throw new NotFoundException('Chat not found');
      if (chatRows[0].type !== 'channel' || !chatRows[0].is_public) {
        throw new ForbiddenException('Not a member of this chat');
      }
    }

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
    if (!rows[0]) throw new NotFoundException('Chat not found');
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

  async createChannel(
    userId: string,
    name: string,
    description?: string,
    isPublic = false,
    username?: string,
    avatarUrl?: string,
  ) {
    if (username) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM users WHERE username = $1
         UNION ALL
         SELECT 1 FROM chats WHERE username = $1
         LIMIT 1`,
        [username],
      );
      if (rows.length > 0) {
        throw new BadRequestException('Username already taken');
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO chats (type, name, description, is_public, username, avatar_url, created_by)
         VALUES ('channel', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, description ?? null, isPublic, username ?? null, avatarUrl ?? null, userId],
      );
      const chatId = rows[0].id;
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [chatId, userId],
      );
      await client.query('COMMIT');
      return { id: chatId, name, type: 'channel', avatar_url: avatarUrl ?? null };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Channel search / join / leave ─────────────────────────────────────────

  async searchChannels(query: string): Promise<ChannelRow[]> {
    if (!query || query.trim().length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT id, type, name, avatar_url,
              username        AS peer_username,
              is_public, description, created_by
       FROM chats
       WHERE type = 'channel'
         AND is_public = TRUE
         AND (name ILIKE $1 OR username ILIKE $1)
       ORDER BY name
       LIMIT 20`,
      [`%${query.trim()}%`],
    );
    return rows;
  }

  async joinChannel(channelId: string, userId: string) {
    const { rows: chat } = await this.pool.query(
      'SELECT id, type, is_public FROM chats WHERE id = $1',
      [channelId],
    );
    if (!chat[0]) throw new NotFoundException('Channel not found');
    if (chat[0].type !== 'channel') throw new BadRequestException('Not a channel');
    if (!chat[0].is_public) throw new ForbiddenException('Channel is private');

    await this.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [channelId, userId],
    );

    const { rows } = await this.pool.query(
      `SELECT c.id, c.type, c.name, c.avatar_url, c.username, c.is_public,
              c.description, c.created_by,
              NULL::text              AS last_message,
              NULL::timestamptz       AS last_message_time,
              0                       AS unread_count,
              FALSE                   AS is_muted,
              FALSE                   AS is_pinned,
              FALSE                   AS is_online,
              FALSE                   AS is_verified
       FROM chats c
       WHERE c.id = $1`,
      [channelId],
    );
    return rows[0] ?? { id: channelId, type: 'channel' };
  }

  async leaveChannel(channelId: string, userId: string): Promise<void> {
    const { rows } = await this.pool.query(
      'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [channelId, userId],
    );
    if (!rows[0]) return; // Already not a member
    if (rows[0].role === 'owner') {
      throw new ForbiddenException('Channel owner cannot leave');
    }
    await this.pool.query(
      'DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [channelId, userId],
    );
  }

  // ── Invite links (private channels) ──────────────────────────────────────

  async generateInviteToken(channelId: string, userId: string): Promise<string> {
    const { rows: member } = await this.pool.query(
      'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [channelId, userId],
    );
    if (!member[0] || member[0].role !== 'owner') {
      throw new ForbiddenException('Only the channel owner can manage invite links');
    }
    const { rows } = await this.pool.query(
      `UPDATE chats
       SET invite_token = encode(gen_random_bytes(16), 'hex')
       WHERE id = $1 AND type = 'channel'
       RETURNING invite_token`,
      [channelId],
    );
    if (!rows[0]) throw new NotFoundException('Channel not found');
    return rows[0].invite_token as string;
  }

  async revokeInviteToken(channelId: string, userId: string): Promise<void> {
    const { rows: member } = await this.pool.query(
      'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [channelId, userId],
    );
    if (!member[0] || member[0].role !== 'owner') {
      throw new ForbiddenException('Only the channel owner can manage invite links');
    }
    await this.pool.query(
      'UPDATE chats SET invite_token = NULL WHERE id = $1',
      [channelId],
    );
  }

  async joinByInvite(token: string, userId: string) {
    const { rows } = await this.pool.query(
      'SELECT id, type FROM chats WHERE invite_token = $1',
      [token],
    );
    if (!rows[0]) throw new NotFoundException('Invalid or expired invite link');
    if (rows[0].type !== 'channel') throw new BadRequestException('Not a channel invite');
    const channelId = rows[0].id as string;

    await this.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [channelId, userId],
    );

    const { rows: chatRows } = await this.pool.query(
      `SELECT c.id, c.type, c.name, c.avatar_url, c.username, c.is_public,
              c.description, c.created_by,
              NULL::text        AS last_message,
              NULL::timestamptz AS last_message_time,
              0                 AS unread_count,
              FALSE             AS is_muted,
              FALSE             AS is_pinned,
              FALSE             AS is_online,
              FALSE             AS is_verified
       FROM chats c WHERE c.id = $1`,
      [channelId],
    );
    return chatRows[0] ?? { id: channelId, type: 'channel' };
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

  async getMemberIds(chatId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT user_id FROM chat_members WHERE chat_id = $1',
      [chatId],
    );
    return rows.map((r) => r.user_id as string);
  }

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
