import {
  Controller, Post, Body, UseGuards, Request,
  HttpCode, HttpStatus, UnauthorizedException,
  Get, Query, Delete, Param,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BridgeService } from './bridge.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { VerifyInitDataDto } from './dto/verify-initdata.dto';
import { createHash } from 'crypto';

@Controller('miniapps')
export class BridgeController {
  constructor(private readonly bridge: BridgeService) {}

  /**
   * POST /api/v1/miniapps/session
   * Called by Flutter before loading a Mini App WebView.
   * Returns a signed initData string.
   */
  @Post('session')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  createSession(@Body() dto: CreateSessionDto, @Request() req: any) {
    return this.bridge.createSession(req.user.id, dto.miniAppId, dto.startParam);
  }

  /**
   * POST /api/v1/miniapps/bridge/verify
   * Called by a Mini App's own backend.
   * Authorization: Bearer {developer_api_key}
   */
  @Post('bridge/verify')
  @HttpCode(HttpStatus.OK)
  async verifyInitData(@Body() dto: VerifyInitDataDto, @Request() req: any) {
    const authHeader: string = req.headers?.authorization ?? '';
    const rawKey = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!rawKey) throw new UnauthorizedException('API key required');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    return this.bridge.verifyInitData(dto.initData, keyHash);
  }

  // ── Sandboxed storage ─────────────────────────────────────────────────────
  // These endpoints are called from the Flutter bridge (JS → Flutter → HTTP)

  @Get('storage')
  @UseGuards(JwtAuthGuard)
  async storageGet(
    @Query('miniAppId') miniAppId: string,
    @Query('key') key: string,
    @Request() req: any,
  ) {
    const value = await this.bridge.storageGet(req.user.id, miniAppId, key);
    return { key, value };
  }

  @Post('storage')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  storageSet(
    @Body() body: { miniAppId: string; key: string; value: string },
    @Request() req: any,
  ) {
    return this.bridge.storageSet(req.user.id, body.miniAppId, body.key, body.value);
  }

  @Delete('storage')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  storageDelete(
    @Query('miniAppId') miniAppId: string,
    @Query('key') key: string,
    @Request() req: any,
  ) {
    return this.bridge.storageDelete(req.user.id, miniAppId, key);
  }

  @Get('storage/all')
  @UseGuards(JwtAuthGuard)
  storageGetAll(@Query('miniAppId') miniAppId: string, @Request() req: any) {
    return this.bridge.storageGetAll(req.user.id, miniAppId);
  }
}
