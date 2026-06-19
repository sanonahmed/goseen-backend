import { Controller, Get, Post, Body, Query, UseGuards, Request } from '@nestjs/common';
import { IsNumber, IsIn } from 'class-validator';
import { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreditsService } from './credits.service';

class RedeemDto {
  @IsNumber() @IsIn([1, 7, 30, 90]) days: number;
}

@UseGuards(JwtAuthGuard)
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get('me')
  getMe(@Request() req: any) {
    return this.creditsService.getMe(req.user.id);
  }

  // Polled by the client right after watching a rewarded ad. The actual
  // credit grant only happens once AdMob's signed SSV callback lands (see
  // AdMobSsvController) — this just reports whether that has happened yet.
  @Get('ad-reward/status')
  getAdRewardStatus(@Request() req: any, @Query('since') since: string) {
    const sinceDate = new Date(since);
    return this.creditsService.getAdRewardStatus(req.user.id, sinceDate);
  }

  @Post('redeem')
  redeem(@Request() req: any, @Body() dto: RedeemDto) {
    return this.creditsService.redeemPremium(req.user.id, dto.days);
  }
}

// No JwtAuthGuard here — this is called directly by Google's ad servers,
// not by the app, and is authenticated by AdMob's SSV signature instead.
@Controller('credits')
export class AdMobSsvController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get('ssv-callback')
  async ssvCallback(@Request() req: ExpressRequest) {
    const queryStart = req.url.indexOf('?');
    const queryString = queryStart === -1 ? '' : req.url.slice(queryStart + 1);
    return this.creditsService.handleSsvCallback(queryString);
  }
}
