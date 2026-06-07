import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ConnectionsController } from './connections.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [forwardRef(() => GatewayModule)],
  providers: [UsersService],
  controllers: [UsersController, ConnectionsController],
  exports: [UsersService],
})
export class UsersModule {}
