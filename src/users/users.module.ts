import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ConnectionsController } from './connections.controller';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [forwardRef(() => GatewayModule), NotificationsModule],
  providers: [UsersService],
  controllers: [UsersController, ConnectionsController],
  exports: [UsersService],
})
export class UsersModule {}
