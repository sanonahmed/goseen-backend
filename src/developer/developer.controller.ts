import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Request,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeveloperService } from './developer.service';
import { RegisterDeveloperDto } from './dto/register-developer.dto';
import { CreateAppDto } from './dto/create-app.dto';
import { UpdateAppDto } from './dto/update-app.dto';
import { SubmitVersionDto } from './dto/submit-version.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@UseGuards(JwtAuthGuard)
@Controller('developer')
export class DeveloperController {
  constructor(private readonly dev: DeveloperService) {}

  // ── Account ───────────────────────────────────────────────────────────────

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDeveloperDto, @Request() req: any) {
    return this.dev.register(req.user.id, dto);
  }

  @Get('me')
  getMe(@Request() req: any) {
    return this.dev.getAccount(req.user.id);
  }

  // ── Apps ──────────────────────────────────────────────────────────────────

  @Get('apps')
  getApps(@Request() req: any) {
    return this.dev.getMyApps(req.user.id);
  }

  @Post('apps')
  @HttpCode(HttpStatus.CREATED)
  createApp(@Body() dto: CreateAppDto, @Request() req: any) {
    return this.dev.createApp(req.user.id, dto);
  }

  @Get('apps/:id')
  getApp(@Param('id') id: string, @Request() req: any) {
    return this.dev.getApp(req.user.id, id);
  }

  @Patch('apps/:id')
  updateApp(@Param('id') id: string, @Body() dto: UpdateAppDto, @Request() req: any) {
    return this.dev.updateApp(req.user.id, id, dto);
  }

  // ── Versions ──────────────────────────────────────────────────────────────

  @Get('apps/:id/versions')
  getVersions(@Param('id') id: string, @Request() req: any) {
    return this.dev.getVersions(req.user.id, id);
  }

  @Post('apps/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  submitVersion(
    @Param('id') id: string,
    @Body() dto: SubmitVersionDto,
    @Request() req: any,
  ) {
    return this.dev.submitVersion(req.user.id, id, dto);
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Get('apps/:id/analytics')
  getAnalytics(
    @Param('id') id: string,
    @Query('range') range: '7d' | '30d' | '90d' = '30d',
    @Request() req: any,
  ) {
    return this.dev.getAnalytics(req.user.id, id, range);
  }

  // ── API Keys ──────────────────────────────────────────────────────────────

  @Get('api-keys')
  getApiKeys(@Request() req: any) {
    return this.dev.getApiKeys(req.user.id);
  }

  @Post('api-keys')
  @HttpCode(HttpStatus.CREATED)
  generateApiKey(@Body() dto: CreateApiKeyDto, @Request() req: any) {
    return this.dev.generateApiKey(req.user.id, dto);
  }

  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeApiKey(@Param('id') id: string, @Request() req: any) {
    return this.dev.revokeApiKey(req.user.id, id);
  }
}
