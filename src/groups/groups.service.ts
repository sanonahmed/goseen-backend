import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export interface CreateGroupDto {
  name: string;
  member_ids: string[];
  description?: string;
  is_public?: boolean;
  avatar_url?: string;
}

export interface UpdateGroupDto {
  name?: string;
  description?: string;
  avatar_url?: string;
  is_public?: boolean;
}

export interface AddMembersDto {
  user_ids: string[];
}

export interface SetMemberRoleDto {
  role: 'admin' | 'member';
}

@Injectable()
export class GroupsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async createGroup(creatorId: string, dto: CreateGroupDto) {
    const groupId = uuidv4();
    const inviteToken = this.generateToken();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert group
      await client.query(
        `INSERT INTO chats (id, type, name, description, avatar_url, is_public, created_by, invite_token, member_count)
         VALUES ($1, 'group', $2, $3, $4, $5, $6, $7, $8)`,
        [groupId, dto.name, dto.description || null, dto.avatar_url || null, dto.is_public || false, creatorId, inviteToken, dto.member_ids.length + 1]
      );

      // Add creator as owner
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', NOW())`,
        [groupId, creatorId]
      );

      // Add initial members
      if (dto.member_ids && dto.member_ids.length > 0) {
        for (const userId of dto.member_ids) {
          await client.query(
            `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
             VALUES ($1, $2, 'member', NOW())
             ON CONFLICT (chat_id, user_id) DO NOTHING`,
            [groupId, userId]
          );
        }
      }

      await client.query('COMMIT');
      return { id: groupId, ...dto };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getGroup(groupId: string, userId: string) {
    await this.assertMember(groupId, userId);

    const { rows } = await this.pool.query(
      `SELECT
        c.id, c.type, c.name, c.description, c.avatar_url, c.is_public,
        c.created_by, c.invite_token, c.member_count, c.pinned_message_id,
        c.created_at, c.updated_at,
        json_agg(json_build_object(
          'id', u.id,
          'user_id', u.id,
          'username', u.username,
          'display_name', u.display_name,
          'avatar_url', u.avatar_url,
          'is_online', u.is_online,
          'role', cm.role,
          'is_muted', cm.is_muted,
          'joined_at', cm.joined_at
        )) FILTER (WHERE u.id IS NOT NULL) AS members
       FROM chats c
       LEFT JOIN chat_members cm ON cm.chat_id = c.id
       LEFT JOIN users u ON u.id = cm.user_id
       WHERE c.id = $1 AND c.type = 'group'
       GROUP BY c.id`,
      [groupId]
    );

    if (!rows[0]) throw new NotFoundException('Group not found');
    return rows[0];
  }

  async updateGroup(groupId: string, userId: string, dto: UpdateGroupDto) {
    const group = await this.getGroup(groupId, userId);
    await this.assertGroupAdmin(groupId, userId);

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (dto.name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(dto.name);
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

    if (updates.length === 0) return group;

    values.push(groupId);
    await this.pool.query(
      `UPDATE chats SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    return this.getGroup(groupId, userId);
  }

  async deleteGroup(groupId: string, userId: string) {
    await this.assertGroupOwner(groupId, userId);

    const { rows } = await this.pool.query(
      `DELETE FROM chats WHERE id = $1 AND type = 'group' RETURNING id`,
      [groupId]
    );

    if (!rows[0]) throw new NotFoundException('Group not found');
  }

  async addMembers(groupId: string, actorId: string, userIds: string[]) {
    await this.assertGroupAdmin(groupId, actorId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let insertedCount = 0;
      for (const userId of userIds) {
        const { rowCount } = await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
           VALUES ($1, $2, 'member', NOW())
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [groupId, userId]
        );
        if (rowCount > 0) insertedCount++;
      }

      // Update member count
      const { rows } = await client.query(
        `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
        [groupId]
      );
      await client.query(
        `UPDATE chats SET member_count = $1 WHERE id = $2`,
        [rows[0].count, groupId]
      );

      await client.query('COMMIT');
      return { added: insertedCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeMember(groupId: string, actorId: string, targetUserId: string) {
    await this.assertGroupAdmin(groupId, actorId);

    if (actorId !== targetUserId) {
      // Check if actor is owner (can remove anyone)
      const { rows: [actor] } = await this.pool.query(
        `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [groupId, actorId]
      );
      if (actor?.role !== 'owner') {
        throw new ForbiddenException('Only admins can remove members');
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [groupId, targetUserId]
      );

      const { rows } = await client.query(
        `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
        [groupId]
      );

      // Delete group if no members left
      if (rows[0].count === 0) {
        await client.query(`DELETE FROM chats WHERE id = $1`, [groupId]);
      } else {
        await client.query(
          `UPDATE chats SET member_count = $1 WHERE id = $2`,
          [rows[0].count, groupId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async leaveGroup(groupId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    if (!member) throw new NotFoundException('Not a member of this group');

    // If owner, must promote another admin or transfer ownership
    if (member.role === 'owner') {
      const { rows: [other] } = await this.pool.query(
        `SELECT user_id FROM chat_members WHERE chat_id = $1 AND role = 'admin' LIMIT 1`,
        [groupId]
      );
      if (other) {
        await this.pool.query(
          `UPDATE chat_members SET role = 'owner' WHERE chat_id = $1 AND user_id = $2`,
          [groupId, other.user_id]
        );
      } else {
        // Delete group if owner is the last one
        const { rows: [cnt] } = await this.pool.query(
          `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
          [groupId]
        );
        if (cnt.count === 1) {
          await this.pool.query(`DELETE FROM chats WHERE id = $1`, [groupId]);
          return;
        }
        throw new BadRequestException('Owner cannot leave without promoting another admin');
      }
    }

    await this.removeMember(groupId, userId, userId);
  }

  async promoteMember(groupId: string, actorId: string, targetUserId: string, role: 'admin' | 'member') {
    await this.assertGroupOwner(groupId, actorId);

    const { rows } = await this.pool.query(
      `UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3
       RETURNING role`,
      [role, groupId, targetUserId]
    );

    if (!rows[0]) throw new NotFoundException('Member not found');
  }

  async getOrCreateInviteLink(groupId: string, userId: string) {
    await this.assertGroupAdmin(groupId, userId);

    const { rows: [group] } = await this.pool.query(
      `SELECT invite_token FROM chats WHERE id = $1`,
      [groupId]
    );

    if (!group) throw new NotFoundException('Group not found');
    if (group.invite_token) {
      return { invite_token: group.invite_token };
    }

    const token = this.generateToken();
    await this.pool.query(
      `UPDATE chats SET invite_token = $1 WHERE id = $2`,
      [token, groupId]
    );

    return { invite_token: token };
  }

  async resetInviteLink(groupId: string, userId: string) {
    await this.assertGroupAdmin(groupId, userId);

    const token = this.generateToken();
    await this.pool.query(
      `UPDATE chats SET invite_token = $1 WHERE id = $2`,
      [token, groupId]
    );

    return { invite_token: token };
  }

  async joinByInviteToken(token: string, userId: string) {
    const { rows: [group] } = await this.pool.query(
      `SELECT id FROM chats WHERE invite_token = $1 AND type = 'group'`,
      [token]
    );

    if (!group) throw new NotFoundException('Invalid invite token');

    await this.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [group.id, userId]
    );

    // Update member count
    const { rows: [cnt] } = await this.pool.query(
      `SELECT COUNT(*)::INT as count FROM chat_members WHERE chat_id = $1`,
      [group.id]
    );
    await this.pool.query(
      `UPDATE chats SET member_count = $1 WHERE id = $2`,
      [cnt.count, group.id]
    );

    return group;
  }

  async pinMessage(groupId: string, userId: string, messageId: string) {
    await this.assertGroupAdmin(groupId, userId);

    const { rows } = await this.pool.query(
      `UPDATE chats SET pinned_message_id = $1 WHERE id = $2 AND type = 'group'
       RETURNING id`,
      [messageId, groupId]
    );

    if (!rows[0]) throw new NotFoundException('Group not found');
  }

  async muteToggle(groupId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT is_muted FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    if (!member) throw new NotFoundException('Not a member');

    await this.pool.query(
      `UPDATE chat_members SET is_muted = NOT is_muted WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    return { is_muted: !member.is_muted };
  }

  async listMembers(groupId: string, userId: string, cursor?: string, limit: number = 20) {
    await this.assertMember(groupId, userId);

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

    const params = cursor ? [groupId, groupId, cursor.split(':')[0], cursor.split(':')[1], limit] : [groupId, limit];
    const { rows } = await this.pool.query(query, params);

    const nextCursor = rows.length === limit ? `${rows[rows.length - 1].id}:${rows[rows.length - 1].joined_at}` : null;

    return { members: rows, nextCursor };
  }

  async searchGroups(query: string, limit: number = 20) {
    const { rows } = await this.pool.query(
      `SELECT id, name, description, avatar_url, member_count, is_public
       FROM chats
       WHERE type = 'group' AND (is_public = TRUE OR name ILIKE $1)
       ORDER BY ts_rank(to_tsvector('simple', name), plainto_tsquery('simple', $2)) DESC
       LIMIT $3`,
      [`%${query}%`, query, limit]
    );

    return rows;
  }

  private async assertMember(groupId: string, userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (!rows[0]) throw new ForbiddenException('Not a member of this group');
  }

  private async assertGroupAdmin(groupId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (!member || !['owner', 'admin'].includes(member.role)) {
      throw new ForbiddenException('Only admins can perform this action');
    }
  }

  private async assertGroupOwner(groupId: string, userId: string) {
    const { rows: [member] } = await this.pool.query(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (!member || member.role !== 'owner') {
      throw new ForbiddenException('Only the group owner can perform this action');
    }
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex').substring(0, 100);
  }
}
