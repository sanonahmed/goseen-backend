import { Module, forwardRef } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { StoriesController } from './stories.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [forwardRef(() => GatewayModule)],
  providers: [StoriesService],
  controllers: [StoriesController],
})
export class StoriesModule {}
