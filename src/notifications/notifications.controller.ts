import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async getNotifications(
    @Request() req: any,
    @Query('limit') limit = '30',
    @Query('unread') unread?: string,
  ) {
    const items = await this.notifications.getForUser(
      req.user.id,
      parseInt(limit),
      unread === 'true',
    );
    return { notifications: items };
  }

  @Get('unread-count')
  async getUnreadCount(@Request() req: any) {
    const count = await this.notifications.getUnreadCount(req.user.id);
    return { count };
  }

  @Post('mark-all-read')
  @HttpCode(204)
  markAllRead(@Request() req: any) {
    return this.notifications.markAllRead(req.user.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(@Request() req: any, @Param('id') id: string) {
    return this.notifications.markRead(id, req.user.id);
  }
}
