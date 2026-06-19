import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { IsString, IsArray, IsOptional, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostsService } from './posts.service';

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
  constructor(private readonly postsService: PostsService) {}

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
    return this.postsService.toggleLike(postId, req.user.id);
  }

  @Post(':postId/bookmark')
  async toggleBookmark(@Request() req: any, @Param('postId') postId: string) {
    return this.postsService.toggleBookmark(postId, req.user.id);
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
    return { comment };
  }
}
