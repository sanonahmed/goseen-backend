import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { ChatsModule } from '../chats/chats.module';
import { MessagesModule } from '../messages/messages.module';
import { UsersModule } from '../users/users.module';
import { CallSessionStore } from '../call/call-session.store';

@Module({
  imports: [
    JwtModule.register({}),
    ChatsModule,
    forwardRef(() => MessagesModule),
    forwardRef(() => UsersModule),
  ],
  providers: [ChatGateway, CallSessionStore],
  exports: [ChatGateway, CallSessionStore],
})
export class GatewayModule {}
