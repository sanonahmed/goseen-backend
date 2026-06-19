import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export type NotificationType =
  | 'new_message'
  | 'mention'
  | 'follow'
  | 'like'
  | 'comment'
  | 'bookmark'
  | 'share'
  | 'connect_request'
  | 'connect_accepted';

@Injectable()
export class NotificationsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(params: {
    recipientId: string;
    actorId?: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.recipientId,
        params.actorId ?? null,
        params.type,
        params.title,
        params.body,
        params.data ? JSON.stringify(params.data) : null,
      ],
    );
    return rows[0];
  }

  async getForUser(userId: string, limit = 30, onlyUnread = false) {
    const unreadClause = onlyUnread ? 'AND is_read = FALSE' : '';
    const { rows } = await this.pool.query(
      `SELECT n.*, u.display_name AS actor_name, u.avatar_url AS actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.recipient_id = $1 ${unreadClause}
       ORDER BY n.created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  async markAllRead(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE recipient_id = $1 AND is_read = FALSE',
      [userId],
    );
  }

  async markRead(notificationId: string, userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND recipient_id = $2',
      [notificationId, userId],
    );
  }

  async getUnreadCount(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE recipient_id = $1 AND is_read = FALSE',
      [userId],
    );
    return rows[0].count;
  }
}
