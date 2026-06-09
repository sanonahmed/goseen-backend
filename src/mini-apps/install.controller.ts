import {
  Controller, Get, Post, Delete, Patch, Param,
  Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InstallService } from './install.service';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';

@UseGuards(JwtAuthGuard)
@Controller('miniapps')
export class InstallController {
  constructor(private readonly install: InstallService) {}

  @Get('installed')
  getInstalled(@Request() req: any) {
    return this.install.getInstalled(req.user.id);
  }

  @Post(':id/install')
  @HttpCode(HttpStatus.CREATED)
  installApp(@Param('id') miniAppId: string, @Request() req: any) {
    return this.install.install(req.user.id, miniAppId);
  }

  @Delete(':id/install')
  @HttpCode(HttpStatus.NO_CONTENT)
  uninstall(@Param('id') miniAppId: string, @Request() req: any) {
    return this.install.uninstall(req.user.id, miniAppId);
  }

  @Patch(':id/install/permissions')
  updatePermissions(
    @Param('id') miniAppId: string,
    @Body() dto: UpdatePermissionsDto,
    @Request() req: any,
  ) {
    return this.install.updatePermissions(req.user.id, miniAppId, dto.granted, dto.denied);
  }

  @Post(':id/install/open')
  @HttpCode(HttpStatus.NO_CONTENT)
  recordOpen(@Param('id') miniAppId: string, @Request() req: any) {
    return this.install.recordOpen(req.user.id, miniAppId);
  }
}
