import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export interface CreateChannelDto {
  name: string;
  username: string;
  description?: string;
  is_public?: boolean;
  avatar_url?: string;
}

export interface UpdateChannelDto {
  name?: string;
  username?: string;
  description?: string;
  avatar_url?: string;
  is_public?: boolean;
}

@Injectable()
export class ChannelsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async createChannel(ownerId: string, dto: CreateChannelDto) {
    const channelId = uuidv4();
    const inviteToken = this.generateToken();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert channel
      await client.query(
        `INSERT INTO chats (id, type, name, description, avatar_url, is_public, created_by, username, invite_token, member_count)
         VALUES ($1, 'channel', $2, $3, $4, $5, $6, $7, $8, 1)`,
        [channelId, dto.name, dto.description || null, dto.avatar_url || null, dto.is_public || false, ownerId, dto.username, inviteToken]
      );

      // Add creator as owner
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', NOW())`,
        [channelId, ownerId]
      );

      await client.query('COMMIT');
      return { id: channelId, ...dto };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getChannel(channelId: string, userId?: string) {
    const { rows: [channel] } = await this.pool.query(
      `SELECT c.*,
        (SELECT COUNT(*)::INT FROM chat_members WHERE chat_id = c.id) as subscriber_count,
        CASE WHEN $2::TEXT IS NOT NULL THEN EXISTS(
          SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $2
        ) ELSE FALSE END as is_subscribed,
        (SELECT role FROM chat_members WHERE chat_id = c.id AND user_id = $2) as my_role
       FROM chats c
       WHERE c.id = $1 AND c.type = 'channel'`,
      [channelId, userId || null]
    );

    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async updateChannel(channelId: string, userId: string, dto: UpdateChannelDto) {
    await this.assertChannelAdmin(channelId, userId);

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (dto.name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(dto.name);
    }
    if (dto.username) {
      updates.push(`username = $${paramIndex++}`);
      values.push(dto.username);
    }
    if (dto.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(dto.description);
    }
    if (dto.avatar_url !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(dto.avatar_url);
    }
    if (dto.is_public !== undefined) {
      updates.push(`is_public = $${paramIndex++}`);
      values.push(dto.is_public);
    }

    if (updates.length === 0) return this.getChannel(channelId, userId);

    values.push(channelId);
    await this.pool.query(
      `UPDATE chats SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    return this.getChannel(channelId, userId);
  }

  async deleteChannel(channelId: string, userId: string) {
    await this.assertChannelOwner(channelId, userId);

    const { rows } = await this.pool.query(
      `DELETE FROM chats WHERE id = $1 AND type = 'channel' RETURNING id`,
      [channelId]
    );

    if (!rows[0]) throw new NotFoundException('Channel not found');
  }

  async subscribe(channelId: string, userId: string) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [channelId, userId]
    );

    // Update subscriber count
    if ((rowCount ?? 0) > 0) {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
        [channelId]
      );
      await this.pool.query(
        `UPDATE chats SET member_count = $1 WHERE id = $2`,
        [rows[0].count, channelId]
      );
    }

    return { subscribed: (rowCount ?? 0) > 0 };
  }

  async unsubscribe(channelId: string, userId: string) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [channelId, userId]
    );

    // Update subscriber count
    if ((rowCount ?? 0) > 0) {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
        [channelId]
      );
      await this.pool.query(
        `UPDATE chats SET member_count = $1 WHERE id = $2`,
        [rows[0].count, channelId]
      );
    }

    return { unsubscribed: (rowCount ?? 0) > 0 };
  }

  async getSubscribers(channelId: string, userId: string, cursor?: string, limit: number = 20) {
    await this.assertChannelAdmin(channelId, userId);

    const query = cursor
      ? `SELECT u.*, cm.role, cm.joined_at FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = $1 AND (cm.joined_at, u.id) < ((SELECT joined_at FROM chat_members WHERE chat_id = $2 AND user_id = $3), $4)
         ORDER BY cm.joined_at DESC, u.id DESC
         LIMIT $5`
      : `SELECT u.*, cm.role, cm.joined_at FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = $1
         ORDER BY cm.joined_at DESC
         LIMIT $2`;

    const params = cursor ? [channelId, channelId, cursor.split(':')[0], cursor.split(':')[1], limit] : [channelId, limit];
    const { rows } = await this.pool.query(query, params);

    const nextCursor = rows.length === limit ? `${rows[rows.length - 1].id}:${rows[rows.length - 1].joined_at}` : null;

    return { subscribers: rows, nextCursor };
  }

  async promoteAdmin(channelId: string, ownerId: string, targetUserId: string) {
    await this.assertChannelOwner(channelId, ownerId);

    const { rows } = await this.pool.query(
      `UPDATE chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2
       RETURNING role`,
      [channelId, targetUserId]
    );

    if (!rows[0]) throw new NotFoundException('Subscriber not found');
  }

  async removeAdmin(channelId: string, ownerId: string, targetUserId: string) {
    await this.assertChannelOwner(channelId, ownerId);

    const { rows } = await this.pool.query(
      `UPDATE chat_members SET role = 'member' WHERE chat_id = $1 AND user_id = $2
       RETURNING role`,
      [channelId, targetUserId]
    );

    if (!rows[0]) throw new NotFoundException('Admin not found');
  }

  async getOrCreateInviteLink(channelId: string, userId: string) {
    await this.assertChannelAdmin(channelId, userId);

    const { rows: [channel] } = await this.pool.query(
      `SELECT invite_token FROM chats WHERE id = $1`,
      [channelId]
    );

    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.invite_token) {
      return { invite_token: channel.invite_token };
    }

    const token = this.generateToken();
    await this.pool.query(
      `UPDATE chats SET invite_token = $1 WHERE id = $2`,
      [token, channelId]
    );

    return { invite_token: token };
  }

  async resetInviteLink(channelId: string, userId: string) {
    await this.assertChannelAdmin(channelId, userId);

    const token = this.generateToken();
    await this.pool.query(
      `UPDATE chats SET invite_token = $1 WHERE id = $2`,
      [token, channelId]
    );

    return { invite_token: token };
  }

  async joinByInviteToken(token: string, userId: string) {
    const { rows: [channel] } = await this.pool.query(
      `SELECT id FROM chats WHERE invite_token = $1 AND type = 'channel'`,
      [token]
    );

    if (!channel) throw new NotFoundException('Invalid invite token');

    const { rowCount } = await this.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [channel.id, userId]
    );

    if ((rowCount ?? 0) > 0) {
      const { rows: [cnt] } = await this.pool.query(
        `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
        [channel.id]
      );
      await this.pool.query(
        `UPDATE chats SET member_count = $1 WHERE id = $2`,
        [cnt.count, channel.id]
      );
    }

    return channel;
  }

  async muteToggle(channelId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT is_muted FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [channelId, userId]
    );

    if (!member) throw new NotFoundException('Not subscribed');

    await this.pool.query(
      `UPDATE chat_members SET is_muted = NOT is_muted WHERE chat_id = $1 AND user_id = $2`,
      [channelId, userId]
    );

    return { is_muted: !member.is_muted };
  }

  async searchChannels(query: string, limit: number = 20) {
    const { rows } = await this.pool.query(
      `SELECT id, name, username, description, avatar_url, member_count, is_public
       FROM chats
       WHERE type = 'channel' AND (is_public = TRUE OR name ILIKE $1 OR username ILIKE $2)
       ORDER BY ts_rank(to_tsvector('simple', name), plainto_tsquery('simple', $3)) DESC
       LIMIT $4`,
      [`%${query}%`, `%${query}%`, query, limit]
    );

    return rows;
  }

  private async assertChannelAdmin(channelId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [channelId, userId]
    );
    if (!member || !['owner', 'admin'].includes(member.role)) {
      throw new ForbiddenException('Only admins can perform this action');
    }
  }

  private async assertChannelOwner(channelId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [channelId, userId]
    );
    if (!member || member.role !== 'owner') {
      throw new ForbiddenException('Only the channel owner can perform this action');
    }
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex').substring(0, 100);
  }
}
