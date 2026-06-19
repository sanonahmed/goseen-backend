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
import { ChatGateway } from '../gateway/chat.gateway';

class UpdateMeDto {
  @IsOptional() @IsString() display_name?: string;
  @IsOptional() @IsString() username?: string;
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
  constructor(
    private readonly users: UsersService,
    private readonly gateway: ChatGateway,
  ) {}

  @Get('me')
  getMe(@Request() req: any) {
    return this.users.getMe(req.user.id);
  }

  @Get('me/profile-visitors')
  getProfileVisitors(@Request() req: any) {
    return this.users.getProfileVisitors(req.user.id);
  }

  @Post('me/profile-visitors/reset')
  @HttpCode(204)
  resetProfileVisitors(@Request() req: any) {
    return this.users.resetProfileVisitors(req.user.id);
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
  async saveE2eeKey(@Request() req: any, @Body() dto: E2eeKeyDto) {
    await this.users.saveE2eeKey(req.user.id, dto.public_key);
    // Notify all personal-chat partners so they invalidate their E2EE secret
    // cache immediately — prevents "[Encrypted message]" after a device change.
    const partnerIds = await this.users.getPersonalChatPartnerIds(req.user.id);
    for (const partnerId of partnerIds) {
      this.gateway.emitToUser(partnerId, 'e2ee_key_rotated', { userId: req.user.id });
    }
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

  @Post(':userId/profile-view')
  @HttpCode(204)
  recordProfileView(@Request() req: any, @Param('userId') userId: string) {
    return this.users.recordProfileView(req.user.id, userId);
  }

  @Post(':userId/follow')
  follow(@Request() req: any, @Param('userId') userId: string) {
    return this.users.followUser(req.user.id, userId);
  }

  @Delete(':userId/follow')
  unfollow(@Request() req: any, @Param('userId') userId: string) {
    return this.users.unfollowUser(req.user.id, userId);
  }

  @Post(':userId/block')
  @HttpCode(204)
  async blockUser(@Request() req: any, @Param('userId') userId: string) {
    await this.users.blockUser(req.user.id, userId);
    this.gateway.emitToUser(userId, 'peer_blocked', { by: req.user.id });
  }

  @Delete(':userId/block')
  @HttpCode(204)
  async unblockUser(@Request() req: any, @Param('userId') userId: string) {
    await this.users.unblockUser(req.user.id, userId);
    this.gateway.emitToUser(userId, 'peer_unblocked', { by: req.user.id });
  }
}
