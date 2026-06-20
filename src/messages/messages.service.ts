import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { ChatsService } from '../chats/chats.service';
import { FcmService } from '../fcm/fcm.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface MentionDto {
  id: string;
  username: string;
}

export interface SendMessageDto {
  text?: string;
  type?: string;
  media_url?: string;
  media_file_id?: string;
  reply_to_id?: string;
  voice_duration?: number;
  mentions?: MentionDto[];
  metadata?: Record<string, unknown>;
}

@Injectable()
export class MessagesService implements OnModuleInit {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly chats: ChatsService,
    private readonly fcm: FcmService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    await this.pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    // story_reply metadata (JSONB, nullable — no default needed)
    await this.pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB`,
    );
  }

  async getMessages(
    chatId: string,
    userId: string,
    limit = 40,
    beforeId?: string,
    since?: string,
  ) {
    const { rows: memberRows } = await this.pool.query(
      'SELECT id FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
    if (!memberRows[0]) {
      const { rows: chatRows } = await this.pool.query(
        'SELECT is_public, type FROM chats WHERE id = $1',
        [chatId],
      );
      if (
        !chatRows[0] ||
        !chatRows[0].is_public ||
        !['channel', 'group'].includes(chatRows[0].type)
      ) {
        throw new ForbiddenException('Not a member of this chat');
      }
    }

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
    } else if (since) {
      queryParams.push(new Date(since));
      timeClause = `AND m.created_at > $4`;
    }

    const { rows } = await this.pool.query(
      `SELECT
         m.id,
         m.chat_id,
         m.sender_id,
         u.display_name  AS sender_name,
         u.username      AS sender_username,
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
         m.metadata,
         COALESCE(m.mentions, '[]'::jsonb) AS mentions,
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
       GROUP BY m.id, u.display_name, u.username, u.avatar_url, rm.text, rm.type, ru.display_name
       ORDER BY m.created_at DESC
       LIMIT $2`,
      queryParams,
    );
    return rows;
  }

  async sendMessage(chatId: string, senderId: string, dto: SendMessageDto) {
    await this.chats.assertMember(chatId, senderId);

    const mentions: MentionDto[] = Array.isArray(dto.mentions) ? dto.mentions : [];

    const { rows } = await this.pool.query(
      `INSERT INTO messages
         (chat_id, sender_id, type, text, media_url, media_file_id, reply_to_id, voice_duration, mentions, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        JSON.stringify(mentions),
        dto.metadata ? JSON.stringify(dto.metadata) : null,
      ],
    );
    const msg = rows[0];

    await this.chats.updateLastMessage(chatId, msg.id, senderId);

    // Fetch with sender info
    const full = await this.getMessageById(msg.id, senderId);

    // Single member fetch → FCM push + in-app notifications in one pass.
    this._notifyMessageRecipients(chatId, senderId, full).catch(() => {});

    // Targeted push for each mentioned user (bypasses mute).
    if (mentions.length > 0) {
      const mentionedIds = mentions.map((m) => m.id);
      this.fcm.notifyMentionedUsers(chatId, senderId, mentionedIds, {
        title: `${full.sender_name ?? 'Someone'} mentioned you`,
        body: full.text ?? '📎 Media',
      }).catch(() => {});
    }

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
         AND m.created_at > NOW() - INTERVAL '30 days'
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
         AND m.created_at > NOW() - INTERVAL '30 days'
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET status = 'seen', seen_at = NOW()`,
      [chatId, userId],
    );
  }

  // ── Batch reactions (one query for N members, replaces N parallel queries) ──

  async getReactionsForAllMembers(
    messageId: string,
    memberIds: string[],
  ): Promise<Map<string, Array<{ emoji: string; count: number; reacted_by_me: boolean }>>> {
    if (memberIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `WITH totals AS (
         SELECT emoji, COUNT(*)::int AS cnt
         FROM message_reactions
         WHERE message_id = $1
         GROUP BY emoji
       ),
       user_reacts AS (
         SELECT emoji, user_id
         FROM message_reactions
         WHERE message_id = $1 AND user_id = ANY($2::uuid[])
       )
       SELECT
         v.viewer_id,
         t.emoji,
         t.cnt,
         (ur.user_id IS NOT NULL) AS reacted_by_me
       FROM (SELECT unnest($2::uuid[]) AS viewer_id) v
       CROSS JOIN totals t
       LEFT JOIN user_reacts ur ON ur.emoji = t.emoji AND ur.user_id = v.viewer_id
       ORDER BY v.viewer_id`,
      [messageId, memberIds],
    );

    const map = new Map<string, Array<{ emoji: string; count: number; reacted_by_me: boolean }>>();
    for (const row of rows) {
      if (!map.has(row.viewer_id)) map.set(row.viewer_id, []);
      map.get(row.viewer_id)!.push({
        emoji:          row.emoji as string,
        count:          row.cnt as number,
        reacted_by_me:  row.reacted_by_me as boolean,
      });
    }
    return map;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getMessageById(id: string, requesterId: string) {
    const { rows } = await this.pool.query(
      `SELECT m.*,
              u.display_name  AS sender_name,
              u.username      AS sender_username,
              u.avatar_url    AS sender_avatar,
              rm.text         AS reply_to_text,
              rm.type         AS reply_to_type,
              ru.display_name AS reply_to_sender_name,
              COALESCE(m.mentions, '[]'::jsonb) AS mentions
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

  private async _notifyMessageRecipients(
    chatId: string,
    senderId: string,
    msg: any,
  ): Promise<void> {
    const { rows } = await this.pool.query<{
      user_id: string;
      fcm_token: string | null;
      is_online: boolean;
    }>(
      `SELECT cm.user_id, u.fcm_token, u.is_online
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1 AND cm.user_id != $2`,
      [chatId, senderId],
    );

    const title  = msg.sender_name ?? 'New message';
    const body   = msg.text ?? '📎 Media';
    const tokens = rows.map((r) => r.fcm_token).filter((t): t is string => !!t);

    await Promise.allSettled([
      this.fcm.sendToTokens(tokens, { title, body }, chatId),
      ...rows
        .filter((r) => !r.is_online)
        .map((r) =>
          this.notifications.create({
            recipientId: r.user_id,
            actorId:     senderId,
            type:        'new_message',
            title,
            body,
            data:        { chatId, messageId: msg.id },
          }),
        ),
    ]);
  }
}
