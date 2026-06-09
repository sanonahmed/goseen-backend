import { Module, forwardRef } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { ChatsModule } from '../chats/chats.module';
import { FcmModule } from '../fcm/fcm.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ChatsModule, FcmModule, NotificationsModule, forwardRef(() => GatewayModule)],
  providers: [MessagesService],
  controllers: [MessagesController],
  exports: [MessagesService],
})
export class MessagesModule {}
