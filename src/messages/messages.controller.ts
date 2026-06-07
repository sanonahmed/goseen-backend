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
  Inject,
  forwardRef,
} from '@nestjs/common';
import { IsString, IsOptional, IsNumber, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessagesService } from './messages.service';
import { ChatsService } from '../chats/chats.service';
import { ChatGateway, SE } from '../gateway/chat.gateway';

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
  constructor(
    private readonly messages: MessagesService,
    private readonly chats: ChatsService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
  ) {}

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
  async sendMessage(
    @Param('chatId') chatId: string,
    @Request() req: any,
    @Body() dto: SendMessageDto,
  ) {
    const msg = await this.messages.sendMessage(chatId, req.user.id, dto);
    this.gateway.emitToChat(chatId, SE.NEW_MSG, { ...msg, chat_id: chatId });
    return msg;
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
  async addReaction(
    @Param('chatId') chatId: string,
    @Param('msgId') msgId: string,
    @Request() req: any,
    @Body() dto: ReactionDto,
  ) {
    await this.messages.addReaction(msgId, req.user.id, dto.emoji);
    await this._broadcastReactions(chatId, msgId);
  }

  @Delete('chats/:chatId/messages/:msgId/reactions')
  async removeReaction(
    @Param('chatId') chatId: string,
    @Param('msgId') msgId: string,
    @Request() req: any,
    @Body() dto: ReactionDto,
  ) {
    await this.messages.removeReaction(msgId, req.user.id, dto.emoji);
    await this._broadcastReactions(chatId, msgId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _broadcastReactions(chatId: string, messageId: string) {
    const memberIds = await this.chats.getMemberIds(chatId);
    await Promise.all(
      memberIds.map(async (memberId) => {
        const reactions = await this.messages.getReactionsForMessage(
          messageId,
          memberId,
        );
        this.gateway.emitToUser(memberId, 'reaction_added', {
          chat_id: chatId,
          message_id: messageId,
          reactions,
        });
      }),
    );
  }
}
