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
import { NotificationsService } from '../notifications/notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
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

    const sender = await this.users.getUserById(req.user.id);
    const senderName = sender?.display_name ?? sender?.username ?? 'Someone';

    // Real-time socket event to the target user
    this.gateway.emitToUser(userId, SE.CONNECTION_REQUEST, {
      user_id: req.user.id,
      username: sender?.username ?? '',
      display_name: sender?.display_name ?? '',
      avatar_url: sender?.avatar_url ?? null,
    });

    // Persist in-app notification
    const notification = await this.notifications.create({
      recipientId: userId,
      actorId: req.user.id,
      type: 'connect_request',
      title: 'Connection request',
      body: `${senderName} sent you a connection request`,
      data: { user_id: req.user.id },
    });
    this.gateway.emitToUser(userId, SE.NEW_NOTIFICATION, notification);
  }

  @Post(':userId/accept')
  @HttpCode(204)
  async accept(@Request() req: any, @Param('userId') userId: string) {
    await this.users.acceptConnectionRequest(userId, req.user.id);

    const accepter = await this.users.getUserById(req.user.id);
    const accepterName = accepter?.display_name ?? accepter?.username ?? 'Someone';

    // Notify the person whose request was accepted
    const notification = await this.notifications.create({
      recipientId: userId,
      actorId: req.user.id,
      type: 'connect_accepted',
      title: 'Connection accepted',
      body: `${accepterName} accepted your connection request`,
      data: { user_id: req.user.id },
    });
    this.gateway.emitToUser(userId, SE.NEW_NOTIFICATION, notification);
  }

  @Post(':userId/decline')
  @HttpCode(204)
  async decline(@Request() req: any, @Param('userId') userId: string) {
    await this.users.declineConnectionRequest(userId, req.user.id);
    // Let the original requester's app know their request was declined so
    // the Connect button reappears without waiting for a manual refresh.
    this.gateway.emitToUser(userId, SE.CONNECTION_DECLINED, {
      user_id: req.user.id,
    });
  }
}
