import { Module } from '@nestjs/common';
import { InitDataService } from './initdata.service';
import { StoreService } from './store.service';
import { InstallService } from './install.service';
import { BridgeService } from './bridge.service';
import { StoreController } from './store.controller';
import { InstallController } from './install.controller';
import { BridgeController } from './bridge.controller';
import { HostedController } from './hosted.controller';

@Module({
  providers: [InitDataService, StoreService, InstallService, BridgeService],
  controllers: [StoreController, InstallController, BridgeController, HostedController],
  exports: [InitDataService, InstallService],
})
export class MiniAppsModule {}
