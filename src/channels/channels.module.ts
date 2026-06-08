import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [DatabaseModule, forwardRef(() => MessagesModule)],
  providers: [ChannelsService],
  controllers: [ChannelsController],
  exports: [ChannelsService],
})
export class ChannelsModule {}
