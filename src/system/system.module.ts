import { Module } from '@nestjs/common';
import { SystemService } from './system.service';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [GatewayModule, NotificationsModule],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
