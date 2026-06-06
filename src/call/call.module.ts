import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CallController } from './call.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [JwtModule.register({}), GatewayModule],
  controllers: [CallController],
})
export class CallModule {}
