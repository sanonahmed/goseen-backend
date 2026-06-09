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
    const post = await this.postsService.createPost(req.user.userId, dto);
    return { post };
  }

  @Get(':postId')
  async getPost(@Request() req: any, @Param('postId') postId: string) {
    return this.postsService.getPost(postId, req.user.userId);
  }

  @Post(':postId/like')
  async toggleLike(@Request() req: any, @Param('postId') postId: string) {
    return this.postsService.toggleLike(postId, req.user.userId);
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
    const comment = await this.postsService.addComment(postId, req.user.userId, dto.text);
    return { comment };
  }
}
