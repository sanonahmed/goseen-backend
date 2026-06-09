import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [SystemModule],
  controllers: [AdminController],
})
export class AdminModule {}
