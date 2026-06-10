import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

const STORY_SELECT = `
  SELECT
    s.id,
    s.user_id,
    s.media_url,
    s.is_video,
    s.text,
    s.text_bg_color_value,
    s.expires_at,
    s.created_at,
    u.username,
    u.display_name,
    u.avatar_url
`;

@Injectable()
export class StoriesService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getFeed(viewerId: string) {
    const { rows } = await this.pool.query(
      `${STORY_SELECT},
        EXISTS(
          SELECT 1 FROM story_views sv
          WHERE sv.story_id = s.id AND sv.viewer_id = $1::uuid
        ) AS is_viewed
       FROM stories s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > NOW()
         AND (
           s.user_id = $1::uuid
           OR EXISTS(
             SELECT 1 FROM connections c
             WHERE c.status = 'accepted'
               AND (
                 (c.follower_id = $1::uuid AND c.following_id = s.user_id)
                 OR (c.following_id = $1::uuid AND c.follower_id = s.user_id)
               )
           )
         )
       ORDER BY (s.user_id = $1::uuid) DESC, s.created_at ASC`,
      [viewerId],
    );
    return rows;
  }

  async createStory(
    userId: string,
    dto: {
      media_url?: string;
      is_video?: boolean;
      text?: string;
      text_bg_color_value?: number;
    },
  ) {
    const { rows } = await this.pool.query(
      `INSERT INTO stories (user_id, media_url, is_video, text, text_bg_color_value)
       VALUES ($1::uuid, $2, $3, $4, $5)
       RETURNING id, user_id, media_url, is_video, text, text_bg_color_value, expires_at, created_at`,
      [
        userId,
        dto.media_url ?? null,
        dto.is_video ?? false,
        dto.text ?? null,
        dto.text_bg_color_value ?? 4283953362,
      ],
    );
    return rows[0];
  }

  async markViewed(storyId: string, viewerId: string) {
    await this.pool.query(
      `INSERT INTO story_views (story_id, viewer_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (story_id, viewer_id) DO NOTHING`,
      [storyId, viewerId],
    );
  }

  async deleteStory(storyId: string, userId: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM stories WHERE id = $1::uuid AND user_id = $2::uuid',
      [storyId, userId],
    );
    if (rowCount === 0) throw new NotFoundException('Story not found or not yours');
  }
}
