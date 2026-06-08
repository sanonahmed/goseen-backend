import { Controller, UseGuards, Post, Get, Patch, Delete, Body, Param, Query, Request } from '@nestjs/common';
import { GroupsService, CreateGroupDto, UpdateGroupDto, AddMembersDto, SetMemberRoleDto } from './groups.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsString, MinLength, MaxLength, IsArray, IsOptional, IsBoolean, ArrayMinSize, IsIn } from 'class-validator';

class CreateGroupDtoValidated {
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;

  @IsArray() @IsString({ each: true }) @ArrayMinSize(1)
  member_ids: string[];

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsBoolean()
  is_public?: boolean;

  @IsOptional() @IsString()
  avatar_url?: string;
}

class UpdateGroupDtoValidated {
  @IsOptional() @IsString() @MinLength(1)
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  avatar_url?: string;

  @IsOptional() @IsBoolean()
  is_public?: boolean;
}

class AddMembersDtoValidated {
  @IsArray() @IsString({ each: true }) @ArrayMinSize(1)
  user_ids: string[];
}

class SetMemberRoleDtoValidated {
  @IsString() @IsIn(['admin', 'member'])
  role: string;
}

@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  async createGroup(@Request() req: any, @Body() dto: CreateGroupDtoValidated) {
    return this.groupsService.createGroup(req.user.id, dto);
  }

  @Get(':id')
  async getGroup(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.getGroup(groupId, req.user.id);
  }

  @Patch(':id')
  async updateGroup(@Param('id') groupId: string, @Request() req: any, @Body() dto: UpdateGroupDtoValidated) {
    return this.groupsService.updateGroup(groupId, req.user.id, dto);
  }

  @Delete(':id')
  async deleteGroup(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.deleteGroup(groupId, req.user.id);
  }

  @Get(':id/members')
  async listMembers(@Param('id') groupId: string, @Query('cursor') cursor: string, @Query('limit') limit = '20', @Request() req: any) {
    return this.groupsService.listMembers(groupId, req.user.id, cursor, parseInt(limit));
  }

  @Post(':id/members')
  async addMembers(@Param('id') groupId: string, @Request() req: any, @Body() dto: AddMembersDtoValidated) {
    return this.groupsService.addMembers(groupId, req.user.id, dto.user_ids);
  }

  @Delete(':id/members/:userId')
  async removeMember(@Param('id') groupId: string, @Param('userId') userId: string, @Request() req: any) {
    return this.groupsService.removeMember(groupId, req.user.id, userId);
  }

  @Post(':id/leave')
  async leaveGroup(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.leaveGroup(groupId, req.user.id);
  }

  @Patch(':id/members/:userId/role')
  async setMemberRole(@Param('id') groupId: string, @Param('userId') userId: string, @Request() req: any, @Body() dto: SetMemberRoleDtoValidated) {
    return this.groupsService.promoteMember(groupId, req.user.id, userId, dto.role as 'admin' | 'member');
  }

  @Get(':id/invite-link')
  async getInviteLink(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.getOrCreateInviteLink(groupId, req.user.id);
  }

  @Post(':id/invite-link/reset')
  async resetInviteLink(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.resetInviteLink(groupId, req.user.id);
  }

  @Post('join/:token')
  async joinByToken(@Param('token') token: string, @Request() req: any) {
    return this.groupsService.joinByInviteToken(token, req.user.id);
  }

  @Patch(':id/pin/:messageId')
  async pinMessage(@Param('id') groupId: string, @Param('messageId') messageId: string, @Request() req: any) {
    return this.groupsService.pinMessage(groupId, req.user.id, messageId);
  }

  @Patch(':id/mute')
  async muteToggle(@Param('id') groupId: string, @Request() req: any) {
    return this.groupsService.muteToggle(groupId, req.user.id);
  }

  @Get()
  async searchGroups(@Query('q') query: string, @Query('limit') limit = '20') {
    return this.groupsService.searchGroups(query, parseInt(limit));
  }
}
