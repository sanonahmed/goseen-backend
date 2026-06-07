import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';

class UpdateMeDto {
  @IsOptional() @IsString() display_name?: string;
  @IsOptional() @IsString() bio?: string;
  @IsOptional() @IsString() avatar_url?: string;
}

class FcmTokenDto {
  @IsString() token!: string;
}

class E2eeKeyDto {
  @IsString() public_key!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  getMe(@Request() req: any) {
    return this.users.getMe(req.user.id);
  }

  @Post('fcm-token')
  @HttpCode(204)
  saveFcmToken(@Request() req: any, @Body() dto: FcmTokenDto) {
    return this.users.saveFcmToken(req.user.id, dto.token);
  }

  @Patch('me')
  updateMe(@Request() req: any, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.id, dto);
  }

  @Post('me/e2ee-key')
  @HttpCode(204)
  saveE2eeKey(@Request() req: any, @Body() dto: E2eeKeyDto) {
    return this.users.saveE2eeKey(req.user.id, dto.public_key);
  }

  @Get(':userId/e2ee-key')
  async getE2eeKey(@Param('userId') userId: string) {
    const key = await this.users.getE2eeKey(userId);
    if (!key) throw new NotFoundException('No E2EE key registered for this user');
    return { public_key: key };
  }

  @Get('online')
  getOnlineConnections(@Request() req: any) {
    return this.users.getConnectedUsers(req.user.id);
  }

  @Get('search')
  search(@Query('q') q: string) {
    return this.users.searchUsers(q ?? '');
  }

  @Get(':username')
  getByUsername(@Param('username') username: string, @Request() req: any) {
    return this.users.getUserByUsername(username, req.user.id);
  }

  @Post(':userId/follow')
  follow(@Request() req: any, @Param('userId') userId: string) {
    return this.users.followUser(req.user.id, userId);
  }

  @Delete(':userId/follow')
  unfollow(@Request() req: any, @Param('userId') userId: string) {
    return this.users.unfollowUser(req.user.id, userId);
  }
}
