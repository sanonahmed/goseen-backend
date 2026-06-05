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
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { IsString, IsOptional, IsNumber, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessagesService } from './messages.service';

class SendMessageDto {
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() media_url?: string;
  @IsOptional() @IsString() media_file_id?: string;
  @IsOptional() @IsString() reply_to_id?: string;
  @IsOptional() @IsNumber() voice_duration?: number;
}

class EditMessageDto {
  @IsString() @MinLength(1) text!: string;
}

class ReactionDto {
  @IsString() emoji!: string;
}

@UseGuards(JwtAuthGuard)
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('chats/:chatId/messages')
  getMessages(
    @Param('chatId') chatId: string,
    @Request() req: any,
    @Query('limit', new DefaultValuePipe(40), ParseIntPipe) limit: number,
    @Query('before_id') beforeId?: string,
  ) {
    return this.messages.getMessages(chatId, req.user.id, limit, beforeId);
  }

  @Post('chats/:chatId/messages')
  sendMessage(
    @Param('chatId') chatId: string,
    @Request() req: any,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.sendMessage(chatId, req.user.id, dto);
  }

  @Patch('chats/:chatId/messages/:msgId')
  editMessage(
    @Param('msgId') msgId: string,
    @Request() req: any,
    @Body() dto: EditMessageDto,
  ) {
    return this.messages.editMessage(msgId, req.user.id, dto.text);
  }

  @Delete('chats/:chatId/messages/:msgId')
  deleteMessage(@Param('msgId') msgId: string, @Request() req: any) {
    return this.messages.deleteMessage(msgId, req.user.id);
  }

  @Post('chats/:chatId/messages/:msgId/reactions')
  addReaction(
    @Param('msgId') msgId: string,
    @Request() req: any,
    @Body() dto: ReactionDto,
  ) {
    return this.messages.addReaction(msgId, req.user.id, dto.emoji);
  }

  @Delete('chats/:chatId/messages/:msgId/reactions/:emoji')
  removeReaction(
    @Param('msgId') msgId: string,
    @Param('emoji') emoji: string,
    @Request() req: any,
  ) {
    return this.messages.removeReaction(msgId, req.user.id, emoji);
  }
}
