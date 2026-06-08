import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { ChatsService } from '../chats/chats.service';
import { FcmService } from '../fcm/fcm.service';

export interface SendMessageDto {
  text?: string;
  type?: string;
  media_url?: string;
  media_file_id?: string;
  reply_to_id?: string;
  voice_duration?: number;
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly chats: ChatsService,
    private readonly fcm: FcmService,
  ) {}

  async getMessages(
    chatId: string,
    userId: string,
    limit = 40,
    beforeId?: string,
  ) {
    await this.chats.assertMember(chatId, userId);

    let timeClause = '';
    // params: $1=chatId, $2=limit, $3=userId, $4=beforeCursor (optional)
    const queryParams: unknown[] = [chatId, limit, userId];

    if (beforeId) {
      const { rows } = await this.pool.query(
        'SELECT created_at FROM messages WHERE id = $1',
        [beforeId],
      );
      if (rows[0]) {
        queryParams.push(rows[0].created_at);
        timeClause = `AND m.created_at < $4`;
      }
    }

    const { rows } = await this.pool.query(
      `SELECT
         m.id,
         m.chat_id,
         m.sender_id,
         u.display_name  AS sender_name,
         u.avatar_url    AS sender_avatar,
         m.type,
         m.text,
         m.media_url,
         m.voice_duration,
         m.reply_to_id,
         rm.text         AS reply_to_text,
         rm.type         AS reply_to_type,
         ru.display_name AS reply_to_sender_name,
         m.is_edited,
         m.created_at,
         COALESCE(
           json_agg(
             json_build_object('emoji', mr.emoji, 'count', mr.cnt, 'reacted_by_me', mr.reacted_by_me)
           ) FILTER (WHERE mr.emoji IS NOT NULL),
           '[]'
         ) AS reactions
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.sender_id
       LEFT JOIN (
         SELECT message_id,
                emoji,
                COUNT(*)::int AS cnt,
                BOOL_OR(user_id = $3) AS reacted_by_me
         FROM message_reactions
         GROUP BY message_id, emoji
       ) mr ON mr.message_id = m.id
       WHERE m.chat_id = $1
         AND m.is_deleted = FALSE
         ${timeClause}
       GROUP BY m.id, u.display_name, u.avatar_url, rm.text, rm.type, ru.display_name
       ORDER BY m.created_at DESC
       LIMIT $2`,
      queryParams,
    );
    return rows;
  }

  async sendMessage(chatId: string, senderId: string, dto: SendMessageDto) {
    await this.chats.assertMember(chatId, senderId);

    // For channels, only admins and owners can post
    const { rows: [chat] } = await this.pool.query(
      `SELECT type FROM chats WHERE id = $1`,
      [chatId]
    );

    if (chat?.type === 'channel') {
      const { rows: [member] } = await this.pool.query(
        `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [chatId, senderId]
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        throw new ForbiddenException('Only admins can post in a channel');
      }
    }

    const { rows } = await this.pool.query(
      `INSERT INTO messages
         (chat_id, sender_id, type, text, media_url, media_file_id, reply_to_id, voice_duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        chatId,
        senderId,
        dto.type ?? 'text',
        dto.text ?? null,
        dto.media_url ?? null,
        dto.media_file_id ?? null,
        dto.reply_to_id ?? null,
        dto.voice_duration ?? null,
      ],
    );
    const msg = rows[0];

    await this.chats.updateLastMessage(chatId, msg.id, senderId);

    // Fetch with sender info
    const full = await this.getMessageById(msg.id, senderId);

    // Fire-and-forget FCM push to all other chat members.
    this.fcm.notifyMessageRecipients(chatId, senderId, {
      title: full.sender_name ?? 'New message',
      body: full.text ?? '📎 Media',
    }).catch(() => {});

    return full;
  }

  async editMessage(messageId: string, userId: string, text: string) {
    const msg = await this.assertSender(messageId, userId);
    const { rows } = await this.pool.query(
      `UPDATE messages SET text = $1, is_edited = TRUE, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [text, messageId],
    );
    return rows[0];
  }

  async deleteMessage(messageId: string, userId: string): Promise<void> {
    await this.assertSender(messageId, userId);
    await this.pool.query(
      'UPDATE messages SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1',
      [messageId],
    );
  }

  async getReactionsForMessage(messageId: string, viewerId: string) {
    const { rows } = await this.pool.query(
      `SELECT emoji,
              COUNT(*)::int AS count,
              BOOL_OR(user_id = $2) AS reacted_by_me
       FROM message_reactions
       WHERE message_id = $1
       GROUP BY emoji
       ORDER BY MIN(created_at)`,
      [messageId, viewerId],
    );
    return rows.map((r) => ({
      emoji: r.emoji as string,
      count: r.count as number,
      reacted_by_me: r.reacted_by_me as boolean,
    }));
  }

  async addReaction(messageId: string, userId: string, emoji: string) {
    await this.pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [messageId, userId, emoji],
    );
  }

  async removeReaction(messageId: string, userId: string, emoji: string) {
    await this.pool.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, userId, emoji],
    );
  }

  async markDelivered(chatId: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_status (message_id, user_id, status)
       SELECT m.id, $2, 'delivered'
       FROM messages m
       WHERE m.chat_id = $1
         AND m.sender_id != $2
         AND NOT EXISTS (
           SELECT 1 FROM message_status ms
           WHERE ms.message_id = m.id AND ms.user_id = $2
         )
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [chatId, userId],
    );
  }

  async markSeen(chatId: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_status (message_id, user_id, status, seen_at)
       SELECT m.id, $2, 'seen', NOW()
       FROM messages m
       WHERE m.chat_id = $1
         AND m.sender_id != $2
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET status = 'seen', seen_at = NOW()`,
      [chatId, userId],
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getMessageById(id: string, requesterId: string) {
    const { rows } = await this.pool.query(
      `SELECT m.*,
              u.display_name  AS sender_name,
              u.avatar_url    AS sender_avatar,
              rm.text         AS reply_to_text,
              rm.type         AS reply_to_type,
              ru.display_name AS reply_to_sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages rm ON rm.id = m.reply_to_id
       LEFT JOIN users ru ON ru.id = rm.sender_id
       WHERE m.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Message not found');
    return { ...rows[0], reactions: [] };
  }

  private async assertSender(messageId: string, userId: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM messages WHERE id = $1',
      [messageId],
    );
    if (!rows[0]) throw new NotFoundException('Message not found');
    if (rows[0].sender_id !== userId) throw new ForbiddenException();
    return rows[0];
  }
}
