import { Module, forwardRef } from '@nestjs/common';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { GatewayModule } from '../gateway/gateway.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    NotificationsModule,
    forwardRef(() => GatewayModule),
    forwardRef(() => UsersModule),
  ],
  providers: [PostsService],
  controllers: [PostsController],
  exports: [PostsService],
})
export class PostsModule {}
