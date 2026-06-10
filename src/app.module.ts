import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ChatsModule } from './chats/chats.module';
import { MessagesModule } from './messages/messages.module';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { GatewayModule } from './gateway/gateway.module';
import { FcmModule } from './fcm/fcm.module';
import { AgoraModule } from './agora/agora.module';
import { CallModule } from './call/call.module';
import { PostsModule } from './posts/posts.module';
import { FeedModule } from './feed/feed.module';
import { AdminModule } from './admin/admin.module';
import { MiniAppsModule } from './mini-apps/mini-apps.module';
import { DeveloperModule } from './developer/developer.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { StoriesModule } from './stories/stories.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ChatsModule,
    MessagesModule,
    MediaModule,
    NotificationsModule,
    GatewayModule,
    FcmModule,
    AgoraModule,
    CallModule,
    PostsModule,
    FeedModule,
    AdminModule,
    MiniAppsModule,
    DeveloperModule,
    AnalyticsModule,
    StoriesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
