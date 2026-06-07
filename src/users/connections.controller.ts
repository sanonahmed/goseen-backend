import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';

@UseGuards(JwtAuthGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly users: UsersService) {}

  @Get('requests')
  getRequests(@Request() req: any) {
    return this.users.getIncomingRequests(req.user.id).then((rows) => ({
      requests: rows,
    }));
  }

  @Post(':userId/request')
  @HttpCode(204)
  sendRequest(@Request() req: any, @Param('userId') userId: string) {
    return this.users.sendConnectionRequest(req.user.id, userId);
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
