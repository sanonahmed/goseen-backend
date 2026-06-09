import { Module } from '@nestjs/common';
import { DeveloperService } from './developer.service';
import { DeveloperController } from './developer.controller';
import { DeveloperApiKeyGuard } from './guards/developer-api-key.guard';

@Module({
  providers: [DeveloperService, DeveloperApiKeyGuard],
  controllers: [DeveloperController],
  exports: [DeveloperService, DeveloperApiKeyGuard],
})
export class DeveloperModule {}
