import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GroupsService } from './groups.service';
import { GroupsController } from './groups.controller';
import { MessagesModule } from '../messages/messages.module';
import { ChatGateway } from '../gateway/chat.gateway';

@Module({
  imports: [DatabaseModule, forwardRef(() => MessagesModule)],
  providers: [GroupsService],
  controllers: [GroupsController],
  exports: [GroupsService],
})
export class GroupsModule {}
