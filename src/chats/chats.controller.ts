import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Inject,
  forwardRef,
} from '@nestjs/common';
import {
  IsString,
  IsArray,
  IsBoolean,
  IsOptional,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatsService } from './chats.service';
import { ChatGateway, SE } from '../gateway/chat.gateway';

class CreatePersonalChatDto {
  @IsString()
  target_user_id!: string;
}

class CreateGroupDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsArray()
  @IsString({ each: true })
  member_ids!: string[];

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() avatar_url?: string;
}

class CreateChannelDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() avatar_url?: string;
}

class UpdateChannelDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() description?: string | null;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() username?: string | null;
  @IsOptional() @IsString() avatar_url?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    @Inject(forwardRef(() => ChatGateway)) private readonly gateway: ChatGateway,
  ) {}

  @Get()
  getChats(@Request() req: any) {
    return this.chats.getChats(req.user.id);
  }

  @Get('channels/search')
  searchChannels(@Query('q') q: string) {
    return this.chats.searchChannels(q ?? '');
  }

  @Post('join-by-invite/:token')
  async joinByInvite(@Param('token') token: string, @Request() req: any) {
    const result = await this.chats.joinByInvite(token, req.user.id);
    this.gateway.emitToChat(result.id, SE.MEMBER_COUNT_UPDATED, { channelId: result.id, delta: 1 });
    return result;
  }

  @Get(':id/stats')
  getChannelStats(@Param('id') id: string, @Request() req: any) {
    return this.chats.getChannelStats(id, req.user.id);
  }

  @Get(':id')
  getChatById(@Param('id') id: string, @Request() req: any) {
    return this.chats.getChatById(id, req.user.id);
  }

  @Post('personal')
  createPersonalChat(@Request() req: any, @Body() dto: CreatePersonalChatDto) {
    return this.chats.createPersonalChat(req.user.id, dto.target_user_id);
  }

  @Post('group')
  async createGroup(@Request() req: any, @Body() dto: CreateGroupDto) {
    const result = await this.chats.createGroup(
      req.user.id,
      dto.name,
      dto.member_ids,
      dto.description,
      dto.is_public,
      dto.username,
      dto.avatar_url,
    );

    // Fire-and-forget: join sockets and notify members.
    // Must not block or throw — group is already committed to DB.
    const allIds = [req.user.id, ...(dto.member_ids ?? [])].filter(
      (id, i, arr) => arr.indexOf(id) === i,
    );
    Promise.all(
      allIds.map(async (memberId) => {
        await this.gateway.joinUserToRoom(memberId, result.id);
        if (memberId !== req.user.id) {
          this.gateway.emitToUser(memberId, SE.NEW_CHAT, {
            id: result.id,
            type: 'group',
            name: result.name,
          });
        }
      }),
    ).catch((err) => console.error('[createGroup] socket error (non-fatal):', err));

    return result;
  }

  @Post('channel')
  createChannel(@Request() req: any, @Body() dto: CreateChannelDto) {
    return this.chats.createChannel(
      req.user.id,
      dto.name,
      dto.description,
      dto.is_public,
      dto.username,
      dto.avatar_url,
    );
  }

  @Patch(':id')
  updateChannel(@Param('id') id: string, @Request() req: any, @Body() dto: UpdateChannelDto) {
    return this.chats.updateChannel(id, req.user.id, {
      name: dto.name,
      description: dto.description,
      isPublic: dto.is_public,
      username: dto.username,
      avatarUrl: dto.avatar_url,
    });
  }

  @Post(':id/seen')
  markSeen(@Param('id') id: string, @Request() req: any) {
    return this.chats.markSeen(id, req.user.id);
  }

  @Post(':id/join')
  async joinChannel(@Param('id') id: string, @Request() req: any) {
    const result = await this.chats.joinChannel(id, req.user.id);
    this.gateway.emitToChat(id, SE.MEMBER_COUNT_UPDATED, { channelId: id, delta: 1 });
    return result;
  }

  @Delete(':id/leave')
  async leaveChannel(@Param('id') id: string, @Request() req: any) {
    await this.chats.leaveChannel(id, req.user.id);
    this.gateway.emitToChat(id, SE.MEMBER_COUNT_UPDATED, { channelId: id, delta: -1 });
  }

  @Post(':id/invite-link')
  async generateInviteLink(@Param('id') id: string, @Request() req: any) {
    const token = await this.chats.generateInviteToken(id, req.user.id);
    return { invite_token: token, invite_link: `https://goseen.org/join/${token}` };
  }

  @Delete(':id/invite-link')
  revokeInviteLink(@Param('id') id: string, @Request() req: any) {
    return this.chats.revokeInviteToken(id, req.user.id);
  }
}
