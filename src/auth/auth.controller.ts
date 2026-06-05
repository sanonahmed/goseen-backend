import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  UseGuards,
  Request,
  Query,
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
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.email, dto.otp);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refreshTokens(dto.refreshToken);
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

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Request() req: any) {
    return this.auth.logout(req.user.id);
  }
}
