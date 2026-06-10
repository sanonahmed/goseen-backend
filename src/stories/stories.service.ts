import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
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
    s.overlays_json,
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
        ) AS is_viewed,
        (
          SELECT emoji FROM story_reactions
          WHERE story_id = s.id AND user_id = $1::uuid
        ) AS my_reaction,
        (
          SELECT COUNT(*) FROM story_reactions WHERE story_id = s.id
        )::int AS reaction_count
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
       ORDER BY (s.user_id = $1::uuid) DESC,
                MAX(s.created_at) OVER (PARTITION BY s.user_id) DESC,
                s.created_at ASC`,
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
      overlays_json?: string;
    },
  ) {
    const { rows } = await this.pool.query(
      `INSERT INTO stories (user_id, media_url, is_video, text, text_bg_color_value, overlays_json)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       RETURNING id, user_id, media_url, is_video, text, text_bg_color_value, overlays_json, expires_at, created_at`,
      [
        userId,
        dto.media_url ?? null,
        dto.is_video ?? false,
        dto.text ?? null,
        dto.text_bg_color_value ?? 4283953362,
        dto.overlays_json ?? null,
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

  // ── Reactions ─────────────────────────────────────────────────────────────

  async reactToStory(storyId: string, userId: string, emoji: string) {
    const { rows: storyRows } = await this.pool.query(
      `SELECT id FROM stories WHERE id = $1::uuid AND expires_at > NOW()`,
      [storyId],
    );
    if (!storyRows[0]) throw new NotFoundException('Story not found or expired');

    const { rows } = await this.pool.query(
      `INSERT INTO story_reactions (story_id, user_id, emoji)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = $3, created_at = NOW()
       RETURNING *`,
      [storyId, userId, emoji],
    );
    return rows[0];
  }

  async removeReaction(storyId: string, userId: string) {
    await this.pool.query(
      `DELETE FROM story_reactions WHERE story_id = $1::uuid AND user_id = $2::uuid`,
      [storyId, userId],
    );
  }

  async getStoryReactions(storyId: string, requesterId: string) {
    const { rows: storyRows } = await this.pool.query(
      `SELECT user_id FROM stories WHERE id = $1::uuid`,
      [storyId],
    );
    if (!storyRows[0]) throw new NotFoundException('Story not found');
    if (storyRows[0].user_id !== requesterId) {
      throw new ForbiddenException('Only the story owner can view reactions');
    }

    const { rows } = await this.pool.query(
      `SELECT sr.emoji, sr.created_at,
              u.id AS user_id, u.display_name, u.username, u.avatar_url
       FROM story_reactions sr
       INNER JOIN users u ON u.id = sr.user_id
       WHERE sr.story_id = $1::uuid
       ORDER BY sr.created_at DESC`,
      [storyId],
    );
    return rows;
  }

  // ── Reply → DM chat ────────────────────────────────────────────────────────

  async replyToStory(storyId: string, replierId: string, text: string) {
    // Get story info for the reply preview
    const { rows: storyRows } = await this.pool.query(
      `SELECT s.id, s.user_id, s.media_url, s.is_video, s.text AS story_text,
              u.display_name
       FROM stories s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.id = $1::uuid AND s.expires_at > NOW()`,
      [storyId],
    );
    if (!storyRows[0]) throw new NotFoundException('Story not found or expired');
    const story = storyRows[0];
    if (story.user_id === replierId) {
      throw new ForbiddenException('Cannot reply to your own story');
    }

    // Find or create personal DM chat between replier and story owner
    const { rows: existingChats } = await this.pool.query(
      `SELECT c.id FROM chats c
       INNER JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1::uuid
       INNER JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2::uuid
       WHERE c.type = 'personal'
       LIMIT 1`,
      [replierId, story.user_id],
    );

    let chatId: string;
    if (existingChats[0]) {
      chatId = existingChats[0].id;
    } else {
      const { rows: newChat } = await this.pool.query(
        `INSERT INTO chats (type) VALUES ('personal') RETURNING id`,
      );
      chatId = newChat[0].id;
      await this.pool.query(
        `INSERT INTO chat_members (chat_id, user_id)
         VALUES ($1, $2::uuid), ($1, $3::uuid)`,
        [chatId, replierId, story.user_id],
      );
    }

    // Insert story_reply message with story preview in metadata
    const metadata = {
      story_id: story.id,
      story_media_url: story.media_url ?? null,
      story_is_video: story.is_video,
      story_text: story.story_text ?? null,
      story_owner_name: story.display_name,
    };

    const { rows: msgRows } = await this.pool.query(
      `INSERT INTO messages (chat_id, sender_id, type, text, metadata)
       VALUES ($1, $2::uuid, 'story_reply', $3, $4)
       RETURNING id, created_at`,
      [chatId, replierId, text, JSON.stringify(metadata)],
    );

    await this.pool.query(
      `UPDATE chats SET last_message_id = $1, last_message_at = NOW() WHERE id = $2`,
      [msgRows[0].id, chatId],
    );

    return { chat_id: chatId, message_id: msgRows[0].id };
  }
}
