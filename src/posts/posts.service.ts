import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

const POST_SELECT = `
  SELECT
    p.id,
    to_timestamp(p.created_at / 1000.0) AS created_at,
    payload->>'caption' AS text,
    ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(payload->'imageUrls', '[]'::jsonb))
    ) AS media_urls,
    LOWER(COALESCE(NULLIF(UPPER(payload->>'mediaType'), 'NONE'), 'none')) AS media_type,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(payload->'hashtags', '[]'::jsonb))),
      ARRAY[]::text[]
    ) AS hashtags,
    ARRAY[]::text[] AS mentions,
    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS likes_count,
    (
      COALESCE((payload->>'commentCount')::int, 0)
      + (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id)::int
    ) AS comments_count,
    0 AS shares_count
`;

@Injectable()
export class PostsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getFeed(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const { rows } = await this.pool.query(
      `${POST_SELECT},
        EXISTS(
          SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
        ) AS is_liked,
        EXISTS(
          SELECT 1 FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.user_id = $1
        ) AS is_bookmarked,
        (
          SELECT status FROM connections
          WHERE follower_id = $1 AND following_id = u.id
        ) AS connection_status,
        json_build_object(
          'id',           payload->>'authorUid',
          'display_name', COALESCE(u.display_name, payload->>'authorDisplayName', 'Unknown'),
          'username',     COALESCE(u.username,     payload->>'authorUsername',    'unknown'),
          'avatar_url',   COALESCE(u.avatar_url,   payload->>'authorPhotoUrl'),
          'is_verified',  false
        ) AS author
      FROM posts p
      LEFT JOIN users u ON u.id::text = payload->>'authorUid'
      WHERE p.is_hidden = false
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows;
  }

  async getHashtagFeed(tag: string, userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const { rows } = await this.pool.query(
      `${POST_SELECT},
        EXISTS(
          SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
        ) AS is_liked,
        EXISTS(
          SELECT 1 FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.user_id = $1
        ) AS is_bookmarked,
        (
          SELECT status FROM connections
          WHERE follower_id = $1 AND following_id = u.id
        ) AS connection_status,
        json_build_object(
          'id',           payload->>'authorUid',
          'display_name', COALESCE(u.display_name, payload->>'authorDisplayName', 'Unknown'),
          'username',     COALESCE(u.username,     payload->>'authorUsername',    'unknown'),
          'avatar_url',   COALESCE(u.avatar_url,   payload->>'authorPhotoUrl'),
          'is_verified',  false
        ) AS author
      FROM posts p
      LEFT JOIN users u ON u.id::text = payload->>'authorUid'
      WHERE p.is_hidden = false
        AND payload->'hashtags' ? $2
      ORDER BY p.created_at DESC
      LIMIT $3 OFFSET $4`,
      [userId, tag, limit, offset],
    );
    return rows;
  }

  async getPost(postId: string, userId: string) {
    const { rows } = await this.pool.query(
      `${POST_SELECT},
        EXISTS(
          SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
        ) AS is_liked,
        EXISTS(
          SELECT 1 FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.user_id = $1
        ) AS is_bookmarked,
        (
          SELECT status FROM connections
          WHERE follower_id = $1 AND following_id = u.id
        ) AS connection_status,
        json_build_object(
          'id',           payload->>'authorUid',
          'display_name', COALESCE(u.display_name, payload->>'authorDisplayName', 'Unknown'),
          'username',     COALESCE(u.username,     payload->>'authorUsername',    'unknown'),
          'avatar_url',   COALESCE(u.avatar_url,   payload->>'authorPhotoUrl'),
          'is_verified',  false
        ) AS author
      FROM posts p
      LEFT JOIN users u ON u.id::text = payload->>'authorUid'
      WHERE p.id = $2 AND p.is_hidden = false`,
      [userId, postId],
    );
    if (!rows[0]) throw new NotFoundException('Post not found');
    return rows[0];
  }

  async toggleLike(postId: string, userId: string) {
    const { rows: exists } = await this.pool.query(
      `SELECT 1 FROM posts WHERE id = $1`,
      [postId],
    );
    if (!exists[0]) throw new NotFoundException('Post not found');

    const { rows: liked } = await this.pool.query(
      `SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2`,
      [postId, userId],
    );
    if (liked.length > 0) {
      await this.pool.query(
        `DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2`,
        [postId, userId],
      );
      return { liked: false };
    }
    await this.pool.query(
      `INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [postId, userId],
    );
    return { liked: true };
  }

  async toggleBookmark(postId: string, userId: string) {
    const { rows: exists } = await this.pool.query(
      `SELECT 1 FROM posts WHERE id = $1`,
      [postId],
    );
    if (!exists[0]) throw new NotFoundException('Post not found');

    const { rows: bookmarked } = await this.pool.query(
      `SELECT 1 FROM post_bookmarks WHERE post_id = $1 AND user_id = $2`,
      [postId, userId],
    );
    if (bookmarked.length > 0) {
      await this.pool.query(
        `DELETE FROM post_bookmarks WHERE post_id = $1 AND user_id = $2`,
        [postId, userId],
      );
      return { bookmarked: false };
    }
    await this.pool.query(
      `INSERT INTO post_bookmarks (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [postId, userId],
    );
    return { bookmarked: true };
  }

  async getBookmarkedPosts(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const { rows } = await this.pool.query(
      `${POST_SELECT},
        EXISTS(
          SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
        ) AS is_liked,
        TRUE AS is_bookmarked,
        (
          SELECT status FROM connections
          WHERE follower_id = $1 AND following_id = u.id
        ) AS connection_status,
        json_build_object(
          'id',           payload->>'authorUid',
          'display_name', COALESCE(u.display_name, payload->>'authorDisplayName', 'Unknown'),
          'username',     COALESCE(u.username,     payload->>'authorUsername',    'unknown'),
          'avatar_url',   COALESCE(u.avatar_url,   payload->>'authorPhotoUrl'),
          'is_verified',  false
        ) AS author
      FROM posts p
      INNER JOIN post_bookmarks pb ON pb.post_id = p.id AND pb.user_id = $1
      LEFT JOIN users u ON u.id::text = payload->>'authorUid'
      WHERE p.is_hidden = false
      ORDER BY pb.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows;
  }

  async searchPosts(query: string, userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const ilike = `%${query}%`;
    // Strip leading # so "#coffee" also matches the hashtags array entry "coffee"
    const tagTerm = query.replace(/^#/, '').toLowerCase();
    const { rows } = await this.pool.query(
      `${POST_SELECT},
        EXISTS(
          SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1
        ) AS is_liked,
        EXISTS(
          SELECT 1 FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.user_id = $1
        ) AS is_bookmarked,
        (
          SELECT status FROM connections
          WHERE follower_id = $1 AND following_id = u.id
        ) AS connection_status,
        json_build_object(
          'id',           payload->>'authorUid',
          'display_name', COALESCE(u.display_name, payload->>'authorDisplayName', 'Unknown'),
          'username',     COALESCE(u.username,     payload->>'authorUsername',    'unknown'),
          'avatar_url',   COALESCE(u.avatar_url,   payload->>'authorPhotoUrl'),
          'is_verified',  false
        ) AS author
      FROM posts p
      LEFT JOIN users u ON u.id::text = payload->>'authorUid'
      WHERE p.is_hidden = false
        AND (
          payload->>'caption' ILIKE $2
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(payload->'hashtags', '[]'::jsonb)) h
            WHERE LOWER(h) = $3
          )
        )
      ORDER BY p.created_at DESC
      LIMIT $4 OFFSET $5`,
      [userId, ilike, tagTerm, limit, offset],
    );
    return rows;
  }

  async getPostInfo(postId: string): Promise<{ authorId: string; authorName: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT payload->>'authorUid' AS author_id,
              COALESCE(u.display_name, payload->>'authorDisplayName', 'Someone') AS author_name
       FROM posts p
       LEFT JOIN users u ON u.id::text = payload->>'authorUid'
       WHERE p.id = $1`,
      [postId],
    );
    if (!rows[0]?.author_id) return null;
    return { authorId: rows[0].author_id, authorName: rows[0].author_name };
  }

  async getComments(postId: string, userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const { rows } = await this.pool.query(
      `SELECT
        pc.id,
        pc.post_id,
        pc.text,
        pc.created_at,
        pc.parent_id,
        pc.media_url,
        (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = pc.id)::int AS likes_count,
        EXISTS(
          SELECT 1 FROM comment_likes cl WHERE cl.comment_id = pc.id AND cl.user_id = $1
        ) AS is_liked,
        CASE WHEN pc.parent_id IS NOT NULL THEN
          (SELECT u2.username FROM post_comments pc2
           JOIN users u2 ON u2.id = pc2.author_id
           WHERE pc2.id = pc.parent_id)
        END AS reply_to_username,
        json_build_object(
          'id',           u.id,
          'display_name', u.display_name,
          'username',     u.username,
          'avatar_url',   u.avatar_url
        ) AS author
      FROM post_comments pc
      LEFT JOIN post_comments parent ON parent.id = pc.parent_id
      JOIN users u ON u.id = pc.author_id
      WHERE pc.post_id = $2
      ORDER BY COALESCE(parent.created_at, pc.created_at) ASC, pc.created_at ASC
      LIMIT $3 OFFSET $4`,
      [userId, postId, limit, offset],
    );
    return rows;
  }

  async addComment(postId: string, userId: string, text: string, parentId?: string, mediaUrl?: string) {
    const { rows: exists } = await this.pool.query(
      `SELECT 1 FROM posts WHERE id = $1`,
      [postId],
    );
    if (!exists[0]) throw new NotFoundException('Post not found');

    const { rows } = await this.pool.query(
      `INSERT INTO post_comments (post_id, author_id, text, parent_id, media_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, post_id, text, created_at, parent_id, media_url`,
      [postId, userId, text, parentId ?? null, mediaUrl ?? null],
    );
    const { rows: user } = await this.pool.query(
      `SELECT id, display_name, username, avatar_url FROM users WHERE id = $1`,
      [userId],
    );
    return {
      ...rows[0],
      likes_count: 0,
      is_liked: false,
      reply_to_username: null,
      author: {
        id: user[0]?.id,
        display_name: user[0]?.display_name,
        username: user[0]?.username,
        avatar_url: user[0]?.avatar_url,
      },
    };
  }

  async toggleCommentLike(commentId: string, userId: string) {
    const { rows: liked } = await this.pool.query(
      `SELECT 1 FROM comment_likes WHERE comment_id = $1 AND user_id = $2`,
      [commentId, userId],
    );
    if (liked.length > 0) {
      await this.pool.query(
        `DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2`,
        [commentId, userId],
      );
      return { liked: false };
    }
    await this.pool.query(
      `INSERT INTO comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [commentId, userId],
    );
    return { liked: true };
  }

  async getUsersByUsernames(usernames: string[]): Promise<{ id: string; username: string }[]> {
    if (!usernames.length) return [];
    const placeholders = usernames.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.pool.query(
      `SELECT id::text, username FROM users WHERE username = ANY(ARRAY[${placeholders}])`,
      usernames,
    );
    return rows;
  }

  async createPost(
    userId: string,
    data: { text?: string; media_urls?: string[]; media_type?: string },
  ) {
    const { rows: user } = await this.pool.query(
      `SELECT id, username, display_name, avatar_url FROM users WHERE id = $1`,
      [userId],
    );
    if (!user[0]) throw new NotFoundException('User not found');
    const u = user[0];

    const hashtags = (data.text?.match(/#(\w+)/g) ?? []).map((h: string) => h.slice(1));
    const payload = {
      authorUid: userId,
      authorUsername: u.username ?? '',
      authorDisplayName: u.display_name ?? '',
      authorPhotoUrl: u.avatar_url ?? null,
      caption: data.text ?? null,
      imageUrls: data.media_urls ?? [],
      mediaType: (data.media_type ?? 'none').toUpperCase(),
      likedBy: [],
      commentCount: 0,
      hashtags,
    };

    const now = Date.now();
    const { rows } = await this.pool.query(
      `INSERT INTO posts (id, created_at, payload, is_hidden)
       VALUES (gen_random_uuid()::text, $1, $2, false)
       RETURNING id`,
      [now, JSON.stringify(payload)],
    );
    return this.getPost(rows[0].id, userId);
  }
}
