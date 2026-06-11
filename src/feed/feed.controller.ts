import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostsService } from '../posts/posts.service';

@UseGuards(JwtAuthGuard)
@Controller('feed')
export class FeedController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  async getFeed(
    @Request() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const posts = await this.postsService.getFeed(
      req.user.id,
      parseInt(page),
      parseInt(limit),
    );
    return { posts };
  }

  @Get('hashtag/:tag')
  async getHashtagFeed(
    @Request() req: any,
    @Param('tag') tag: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const posts = await this.postsService.getHashtagFeed(
      tag,
      req.user.id,
      parseInt(page),
      parseInt(limit),
    );
    return { posts };
  }
}
