import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { ChatsModule } from '../chats/chats.module';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    JwtModule.register({}),
    ChatsModule,
    MessagesModule,
    NotificationsModule,
    UsersModule,
  ],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class GatewayModule {}
