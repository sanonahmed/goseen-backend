import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { IsString, IsArray, IsOptional, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostsService } from './posts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { ChatGateway, SE } from '../gateway/chat.gateway';

class CreatePostDto {
  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsArray()
  media_urls?: string[];

  @IsOptional()
  @IsString()
  media_type?: string;
}

class AddCommentDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    @Inject(forwardRef(() => ChatGateway)) private readonly gateway: ChatGateway,
  ) {}

  @Post()
  async createPost(@Request() req: any, @Body() dto: CreatePostDto) {
    const post = await this.postsService.createPost(req.user.id, dto);
    return { post };
  }

  // Declared before ':postId' so it isn't swallowed by that wildcard route.
  @Get('bookmarks')
  async getBookmarks(
    @Request() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const posts = await this.postsService.getBookmarkedPosts(
      req.user.id,
      parseInt(page),
      parseInt(limit),
    );
    return { posts };
  }

  @Get(':postId')
  async getPost(@Request() req: any, @Param('postId') postId: string) {
    return this.postsService.getPost(postId, req.user.id);
  }

  @Post(':postId/like')
  async toggleLike(@Request() req: any, @Param('postId') postId: string) {
    const result = await this.postsService.toggleLike(postId, req.user.id);

    // Only notify on a new like (not on un-like), and never self-notify.
    if (result.liked) {
      this._notifyPostAuthor(postId, req.user.id, 'like').catch(() => null);
    }

    return result;
  }

  @Post(':postId/bookmark')
  async toggleBookmark(@Request() req: any, @Param('postId') postId: string) {
    const result = await this.postsService.toggleBookmark(postId, req.user.id);

    if (result.bookmarked) {
      this._notifyPostAuthor(postId, req.user.id, 'bookmark').catch(() => null);
    }

    return result;
  }

  @Get(':postId/comments')
  async getComments(
    @Param('postId') postId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '30',
  ) {
    const comments = await this.postsService.getComments(
      postId,
      parseInt(page),
      parseInt(limit),
    );
    return { comments };
  }

  @Post(':postId/comments')
  async addComment(
    @Request() req: any,
    @Param('postId') postId: string,
    @Body() dto: AddCommentDto,
  ) {
    const comment = await this.postsService.addComment(postId, req.user.id, dto.text);

    this._notifyPostAuthor(postId, req.user.id, 'comment', {
      comment_text: dto.text.substring(0, 100),
      comment_id: comment.id,
    }).catch(() => null);

    return { comment };
  }

  // ── Shared notification helper ────────────────────────────────────────────

  private async _notifyPostAuthor(
    postId: string,
    actorId: string,
    type: 'like' | 'comment' | 'bookmark',
    extra?: Record<string, unknown>,
  ) {
    const post = await this.postsService.getPostInfo(postId);
    if (!post || post.authorId === actorId) return; // never self-notify

    const actor = await this.users.getUserById(actorId);
    const actorName = actor?.display_name ?? actor?.username ?? 'Someone';

    const titleMap = { like: 'New like', comment: 'New comment', bookmark: 'New bookmark' };
    const bodyMap = {
      like: `${actorName} liked your post`,
      comment: `${actorName} commented on your post`,
      bookmark: `${actorName} bookmarked your post`,
    };

    const notification = await this.notifications.create({
      recipientId: post.authorId,
      actorId,
      type,
      title: titleMap[type],
      body: bodyMap[type],
      data: { post_id: postId, ...extra },
    });

    this.gateway.emitToUser(post.authorId, SE.NEW_NOTIFICATION, notification);
  }
}
