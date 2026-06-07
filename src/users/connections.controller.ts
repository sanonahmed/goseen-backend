import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
  HttpCode,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { ChatGateway, SE } from '../gateway/chat.gateway';

@UseGuards(JwtAuthGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly users: UsersService,
    @Inject(forwardRef(() => ChatGateway)) private readonly gateway: ChatGateway,
  ) {}

  @Get('requests')
  getRequests(@Request() req: any) {
    return this.users.getIncomingRequests(req.user.id).then((rows) => ({
      requests: rows,
    }));
  }

  @Post(':userId/request')
  @HttpCode(204)
  async sendRequest(@Request() req: any, @Param('userId') userId: string) {
    await this.users.sendConnectionRequest(req.user.id, userId);
    // Push a real-time socket event to the target user so their app
    // refreshes the requests tab instantly without polling.
    const sender = await this.users.getUserById(req.user.id);
    this.gateway.emitToUser(userId, SE.CONNECTION_REQUEST, {
      user_id: req.user.id,
      username: sender?.username ?? '',
      display_name: sender?.display_name ?? '',
      avatar_url: sender?.avatar_url ?? null,
    });
  }

  @Post(':userId/accept')
  @HttpCode(204)
  accept(@Request() req: any, @Param('userId') userId: string) {
    return this.users.acceptConnectionRequest(userId, req.user.id);
  }

  @Post(':userId/decline')
  @HttpCode(204)
  decline(@Request() req: any, @Param('userId') userId: string) {
    return this.users.declineConnectionRequest(userId, req.user.id);
  }
}
