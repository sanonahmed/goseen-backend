import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

@Injectable()
export class UsersService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getMe(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, email, username, display_name, avatar_url, bio, is_online, last_seen, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException('User not found');
    return rows[0];
  }

  async getUserByUsername(username: string, requesterId?: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio,
              u.is_online, u.last_seen,
              COUNT(DISTINCT c1.id) FILTER (WHERE c1.status = 'accepted') AS followers_count,
              COUNT(DISTINCT c2.id) FILTER (WHERE c2.status = 'accepted') AS following_count,
              MAX(c3.status) AS connection_status
       FROM users u
       LEFT JOIN connections c1 ON c1.following_id = u.id
       LEFT JOIN connections c2 ON c2.follower_id  = u.id
       LEFT JOIN connections c3 ON c3.follower_id  = $2 AND c3.following_id = u.id
       WHERE u.username = $1
       GROUP BY u.id`,
      [username, requesterId ?? null],
    );
    if (!rows[0]) throw new NotFoundException('User not found');
    return rows[0];
  }

  async updateMe(
    userId: string,
    updates: { display_name?: string; bio?: string; avatar_url?: string },
  ) {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.display_name !== undefined) {
      fields.push(`display_name = $${idx++}`);
      values.push(updates.display_name);
    }
    if (updates.bio !== undefined) {
      fields.push(`bio = $${idx++}`);
      values.push(updates.bio);
    }
    if (updates.avatar_url !== undefined) {
      fields.push(`avatar_url = $${idx++}`);
      values.push(updates.avatar_url);
    }
    if (fields.length === 0) return this.getMe(userId);

    values.push(userId);
    const { rows } = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING id, email, username, display_name, avatar_url, bio`,
      values,
    );
    return rows[0];
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET fcm_token = $1 WHERE id = $2',
      [token, userId],
    );
  }

  async saveE2eeKey(userId: string, publicKey: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET e2ee_public_key = $1 WHERE id = $2',
      [publicKey, userId],
    );
  }

  async getE2eeKey(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT e2ee_public_key FROM users WHERE id = $1',
      [userId],
    );
    return (rows[0]?.e2ee_public_key as string | null) ?? null;
  }

  async setOnlineStatus(userId: string, isOnline: boolean): Promise<void> {
    await this.pool.query(
      'UPDATE users SET is_online = $1, last_seen = NOW() WHERE id = $2',
      [isOnline, userId],
    );
  }

  async getLastSeen(userId: string): Promise<Date | undefined> {
    const { rows } = await this.pool.query(
      'SELECT last_seen FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.last_seen as Date | undefined;
  }

  async getUserById(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, username, display_name, avatar_url FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async getOnlineUsers(userIds: string[]) {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.pool.query(
      `SELECT id, is_online, last_seen FROM users WHERE id IN (${placeholders})`,
      userIds,
    );
    return rows;
  }

  async searchUsers(query: string, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT id, username, display_name, avatar_url, is_online
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       LIMIT $2`,
      [`%${query}%`, limit],
    );
    return rows;
  }

  // ── Connections ────────────────────────────────────────────────────────────

  async followUser(followerId: string, followingId: string) {
    await this.pool.query(
      `INSERT INTO connections (follower_id, following_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [followerId, followingId],
    );
  }

  async unfollowUser(followerId: string, followingId: string) {
    await this.pool.query(
      'DELETE FROM connections WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId],
    );
  }

  // Returns accepted connections (anyone I follow or who follows me) ordered
  // by online first, then most-recently-seen.
  async getConnectedUsers(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_url,
              u.is_online, u.last_seen
       FROM users u
       INNER JOIN connections c ON (
         (c.follower_id = $1 AND c.following_id = u.id)
         OR
         (c.following_id = $1 AND c.follower_id = u.id)
       )
       WHERE c.status = 'accepted' AND u.id != $1
       ORDER BY u.is_online DESC, u.last_seen DESC
       LIMIT 100`,
      [userId],
    );
    return rows;
  }

  // Incoming pending requests (others sent to me).
  async getIncomingRequests(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT u.id AS user_id, u.username, u.display_name, u.avatar_url,
              u.is_online, c.created_at AS requested_at
       FROM connections c
       INNER JOIN users u ON u.id = c.follower_id
       WHERE c.following_id = $1 AND c.status = 'pending'
       ORDER BY c.created_at DESC`,
      [userId],
    );
    return rows;
  }

  async sendConnectionRequest(fromId: string, toId: string) {
    await this.pool.query(
      `INSERT INTO connections (follower_id, following_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (follower_id, following_id) DO NOTHING`,
      [fromId, toId],
    );
  }

  async acceptConnectionRequest(requesterId: string, acceptorId: string) {
    await this.pool.query(
      `UPDATE connections SET status = 'accepted'
       WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'`,
      [requesterId, acceptorId],
    );
  }

  async declineConnectionRequest(requesterId: string, declinerId: string) {
    await this.pool.query(
      `DELETE FROM connections
       WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'`,
      [requesterId, declinerId],
    );
  }
}
