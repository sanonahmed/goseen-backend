import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { IsNumber, IsIn } from 'class-validator';
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

  @Post('ad-reward')
  adReward(@Request() req: any) {
    return this.creditsService.adReward(req.user.id);
  }

  @Post('redeem')
  redeem(@Request() req: any, @Body() dto: RedeemDto) {
    return this.creditsService.redeemPremium(req.user.id, dto.days);
  }
}
