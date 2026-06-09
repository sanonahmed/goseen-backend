import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { PostsModule } from '../posts/posts.module';

@Module({
  imports: [PostsModule],
  controllers: [FeedController],
})
export class FeedModule {}
