import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatGateway } from '../gateway/chat.gateway';
import { FcmService } from '../fcm/fcm.service';
import { SE } from '../gateway/chat.gateway';

interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

/** In-memory call sessions: channelName → { callerId, calleeId } */
const sessions = new Map<string, { callerId: string; calleeId: string }>();

@Controller('call')
@UseGuards(JwtAuthGuard)
export class CallController {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly fcm: FcmService,
  ) {}

  @Post('invite')
  async invite(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      targetUserId: string;
      channelName: string;
      callerName: string;
      callerAvatar?: string;
      callType: string;
    },
  ) {
    const callerId = req.user.id;
    sessions.set(body.channelName, {
      callerId,
      calleeId: body.targetUserId,
    });

    const payload = {
      callerId,
      callerName: body.callerName,
      callerAvatar: body.callerAvatar ?? null,
      channelName: body.channelName,
      callType: body.callType,
    };

    // Socket (instant when callee is connected)
    this.gateway.emitToUser(body.targetUserId, SE.INCOMING_CALL, payload);

    // FCM (reliable delivery when callee is backgrounded/killed)
    await this.fcm.notifyCallEvent(body.targetUserId, 'call_invite', {
      callerId,
      callerName: body.callerName,
      callerAvatar: body.callerAvatar ?? '',
      channelName: body.channelName,
      callType: body.callType,
    });

    console.log(
      `[Call/HTTP] invite from=${callerId} to=${body.targetUserId} channel=${body.channelName}`,
    );
    return { ok: true };
  }

  @Post('cancel')
  async cancel(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string },
  ) {
    const session = sessions.get(body.channelName);
    if (!session) return { ok: true };

    this.gateway.emitToUser(session.calleeId, SE.CALL_CANCELLED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(session.calleeId, 'call_cancel', {
      channelName: body.channelName,
    });

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] cancel channel=${body.channelName}`);
    return { ok: true };
  }

  @Post('answer')
  async answer(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string },
  ) {
    const session = sessions.get(body.channelName);
    if (!session) return { ok: true };

    this.gateway.emitToUser(session.callerId, SE.CALL_ACCEPTED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(session.callerId, 'call_accept', {
      channelName: body.channelName,
    });

    console.log(`[Call/HTTP] answer channel=${body.channelName}`);
    return { ok: true };
  }

  @Post('reject')
  async reject(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string },
  ) {
    const session = sessions.get(body.channelName);
    if (!session) return { ok: true };

    this.gateway.emitToUser(session.callerId, SE.CALL_REJECTED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(session.callerId, 'call_reject', {
      channelName: body.channelName,
    });

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] reject channel=${body.channelName}`);
    return { ok: true };
  }

  @Post('end')
  async end(@Req() req: AuthedRequest, @Body() body: { channelName: string }) {
    const session = sessions.get(body.channelName);
    if (!session) return { ok: true };

    const enderId = req.user.id;
    const otherId =
      enderId === session.callerId ? session.calleeId : session.callerId;

    this.gateway.emitToUser(otherId, SE.CALL_ENDED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(otherId, 'call_end', {
      channelName: body.channelName,
    });

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] end channel=${body.channelName}`);
    return { ok: true };
  }
}
