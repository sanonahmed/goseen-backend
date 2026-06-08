import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
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

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}

  @Get()
  getChats(@Request() req: any) {
    return this.chats.getChats(req.user.id);
  }

  @Get('channels/search')
  searchChannels(@Query('q') q: string) {
    return this.chats.searchChannels(q ?? '');
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
  createGroup(@Request() req: any, @Body() dto: CreateGroupDto) {
    return this.chats.createGroup(
      req.user.id,
      dto.name,
      dto.member_ids,
      dto.description,
      dto.is_public,
      dto.avatar_url,
    );
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

  @Post(':id/seen')
  markSeen(@Param('id') id: string, @Request() req: any) {
    return this.chats.markSeen(id, req.user.id);
  }

  @Post(':id/join')
  joinChannel(@Param('id') id: string, @Request() req: any) {
    return this.chats.joinChannel(id, req.user.id);
  }

  @Delete(':id/leave')
  leaveChannel(@Param('id') id: string, @Request() req: any) {
    return this.chats.leaveChannel(id, req.user.id);
  }
}
