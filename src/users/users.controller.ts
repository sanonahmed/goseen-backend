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
