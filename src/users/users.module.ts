import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ConnectionsController } from './connections.controller';

@Module({
  providers: [UsersService],
  controllers: [UsersController, ConnectionsController],
  exports: [UsersService],
})
export class UsersModule {}
