import { Module } from '@nestjs/common';
import { CreditsService } from './credits.service';
import { CreditsController, AdMobSsvController } from './credits.controller';

@Module({
  providers: [CreditsService],
  controllers: [CreditsController, AdMobSsvController],
})
export class CreditsModule {}
