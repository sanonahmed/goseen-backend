import { Controller, UseGuards, Post, Get, Patch, Delete, Body, Param, Query, Request } from '@nestjs/common';
import { ChannelsService, CreateChannelDto, UpdateChannelDto } from './channels.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsString, MinLength, MaxLength, IsArray, IsOptional, IsBoolean } from 'class-validator';

class CreateChannelDtoValidated {
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;

  @IsString() @MinLength(1) @MaxLength(50)
  username: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsBoolean()
  is_public?: boolean;

  @IsOptional() @IsString()
  avatar_url?: string;
}

class UpdateChannelDtoValidated {
  @IsOptional() @IsString() @MinLength(1)
  name?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(50)
  username?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  avatar_url?: string;

  @IsOptional() @IsBoolean()
  is_public?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Post()
  async createChannel(@Request() req: any, @Body() dto: CreateChannelDtoValidated) {
    return this.channelsService.createChannel(req.user.id, dto);
  }

  @Get(':id')
  async getChannel(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.getChannel(channelId, req.user.id);
  }

  @Patch(':id')
  async updateChannel(@Param('id') channelId: string, @Request() req: any, @Body() dto: UpdateChannelDtoValidated) {
    return this.channelsService.updateChannel(channelId, req.user.id, dto);
  }

  @Delete(':id')
  async deleteChannel(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.deleteChannel(channelId, req.user.id);
  }

  @Post(':id/subscribe')
  async subscribe(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.subscribe(channelId, req.user.id);
  }

  @Delete(':id/subscribe')
  async unsubscribe(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.unsubscribe(channelId, req.user.id);
  }

  @Get(':id/subscribers')
  async getSubscribers(@Param('id') channelId: string, @Query('cursor') cursor: string, @Query('limit') limit = '20', @Request() req: any) {
    return this.channelsService.getSubscribers(channelId, req.user.id, cursor, parseInt(limit));
  }

  @Patch(':id/admins/:userId')
  async promoteAdmin(@Param('id') channelId: string, @Param('userId') userId: string, @Request() req: any) {
    return this.channelsService.promoteAdmin(channelId, req.user.id, userId);
  }

  @Delete(':id/admins/:userId')
  async removeAdmin(@Param('id') channelId: string, @Param('userId') userId: string, @Request() req: any) {
    return this.channelsService.removeAdmin(channelId, req.user.id, userId);
  }

  @Get(':id/invite-link')
  async getInviteLink(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.getOrCreateInviteLink(channelId, req.user.id);
  }

  @Post(':id/invite-link/reset')
  async resetInviteLink(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.resetInviteLink(channelId, req.user.id);
  }

  @Post('join/:token')
  async joinByToken(@Param('token') token: string, @Request() req: any) {
    return this.channelsService.joinByInviteToken(token, req.user.id);
  }

  @Patch(':id/mute')
  async muteToggle(@Param('id') channelId: string, @Request() req: any) {
    return this.channelsService.muteToggle(channelId, req.user.id);
  }

  @Get()
  async searchChannels(@Query('q') query: string, @Query('limit') limit = '20') {
    return this.channelsService.searchChannels(query, parseInt(limit));
  }
}
