import {
  Controller,
  Post,
  Patch,
  Get,
  Delete,
  Body,
  UseGuards,
  Request,
  Query,
  Param,
} from '@nestjs/common';
import { IsEmail, IsString, Length, MinLength } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

class SendOtpDto {
  @IsEmail()
  email!: string;
}

class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class SetupUsernameDto {
  @IsString()
  @Length(3, 30)
  username!: string;
}

class SetupProfileDto {
  @IsString()
  @MinLength(1)
  display_name!: string;

  @IsString()
  avatar_url?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.auth.sendOtp(dto.email);
  }

  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto, @Request() req: any) {
    return this.auth.verifyOtp(dto.email, dto.otp, this.extractDeviceInfo(req));
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Request() req: any) {
    return this.auth.refreshTokens(dto.refreshToken, this.extractDeviceInfo(req));
  }

  @UseGuards(JwtAuthGuard)
  @Patch('setup-username')
  setupUsername(@Request() req: any, @Body() dto: SetupUsernameDto) {
    return this.auth.setupUsername(req.user.id, dto.username);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('setup-profile')
  setupProfile(@Request() req: any, @Body() dto: SetupProfileDto) {
    return this.auth.setupProfile(req.user.id, dto.display_name, dto.avatar_url);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.auth.getMe(req.user.id);
  }

  @Get('check-username')
  checkUsername(@Query('username') username: string) {
    return this.auth.checkUsernameAvailable(username).then((available) => ({ available }));
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Request() req: any) {
    return this.auth.logout(req.user.id, req.user.sid);
  }

  // ── Device session management ──────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  getSessions(@Request() req: any) {
    return this.auth.getSessions(req.user.id, req.user.sid);
  }

  // Must be defined before sessions/:id so it is not shadowed by the param route
  @UseGuards(JwtAuthGuard)
  @Delete('sessions/others')
  terminateOtherSessions(@Request() req: any) {
    return this.auth.terminateOtherSessions(req.user.id, req.user.sid);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  terminateSession(@Request() req: any, @Param('id') id: string) {
    return this.auth.terminateSession(req.user.id, id, req.user.sid);
  }

  // Temporary debug endpoint — remove before ship
  @Get('debug-token')
  debugToken(@Request() req: any) {
    const authHeader = req.headers.authorization as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
      return { valid: false, reason: 'No Bearer token in Authorization header', header: authHeader ?? null };
    }
    const token = authHeader.split(' ')[1];
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    console.log('[DEBUG] secret present:', !!secret, 'len:', secret?.length);
    try {
      const payload = this.jwt.verify(token, { secret });
      return { valid: true, payload };
    } catch (e: any) {
      return { valid: false, reason: e.message, tokenPrefix: token.substring(0, 30) };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractDeviceInfo(req: any) {
    const forwarded = req.headers['x-forwarded-for'] as string | undefined;
    const ip = forwarded?.split(',')[0]?.trim() ?? req.ip ?? null;
    return {
      platform: (req.headers['x-device-platform'] as string | undefined) ?? undefined,
      deviceName: (req.headers['x-device-name'] as string | undefined) ?? undefined,
      ip: ip ?? undefined,
    };
  }
}
