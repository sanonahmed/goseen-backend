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

/**
 * In-memory session cache: channelName → { callerId, calleeId }.
 * Used as a fallback only — clients always send the target user ID directly
 * so signaling works even if the session was lost on a server restart.
 */
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
      callerAvatar: body.callerAvatar ?? '',
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
    // calleeId sent by client so we don't rely on server-side session state
    @Body() body: { channelName: string; calleeId?: string },
  ) {
    const calleeId =
      body.calleeId ?? sessions.get(body.channelName)?.calleeId;

    if (!calleeId) {
      console.warn(`[Call/HTTP] cancel – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    this.gateway.emitToUser(calleeId, SE.CALL_CANCELLED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(calleeId, 'call_cancel', {
      channelName: body.channelName,
    });

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] cancel channel=${body.channelName} callee=${calleeId}`);
    return { ok: true };
  }

  @Post('answer')
  async answer(
    @Req() req: AuthedRequest,
    // callerId sent by client so we don't rely on server-side session state
    @Body() body: { channelName: string; callerId?: string },
  ) {
    const callerId =
      body.callerId ?? sessions.get(body.channelName)?.callerId;

    if (!callerId) {
      console.warn(`[Call/HTTP] answer – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    this.gateway.emitToUser(callerId, SE.CALL_ACCEPTED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(callerId, 'call_accept', {
      channelName: body.channelName,
    });

    console.log(`[Call/HTTP] answer channel=${body.channelName} caller=${callerId}`);
    return { ok: true };
  }

  @Post('reject')
  async reject(
    @Req() req: AuthedRequest,
    // callerId sent by client so we don't rely on server-side session state
    @Body() body: { channelName: string; callerId?: string },
  ) {
    const callerId =
      body.callerId ?? sessions.get(body.channelName)?.callerId;

    if (!callerId) {
      console.warn(`[Call/HTTP] reject – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    this.gateway.emitToUser(callerId, SE.CALL_REJECTED, {
      channelName: body.channelName,
    });
    await this.fcm.notifyCallEvent(callerId, 'call_reject', {
      channelName: body.channelName,
    });

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] reject channel=${body.channelName} caller=${callerId}`);
    return { ok: true };
  }

  @Post('end')
  async end(
    @Req() req: AuthedRequest,
    // otherUserId sent by client so we don't rely on server-side session state
    @Body() body: { channelName: string; otherUserId?: string },
  ) {
    const enderId = req.user.id;
    let otherId = body.otherUserId;

    if (!otherId) {
      const session = sessions.get(body.channelName);
      if (session) {
        otherId =
          enderId === session.callerId ? session.calleeId : session.callerId;
      }
    }

    if (otherId) {
      this.gateway.emitToUser(otherId, SE.CALL_ENDED, {
        channelName: body.channelName,
      });
      await this.fcm.notifyCallEvent(otherId, 'call_end', {
        channelName: body.channelName,
      });
    } else {
      console.warn(`[Call/HTTP] end – no session for channel=${body.channelName}`);
    }

    sessions.delete(body.channelName);
    console.log(`[Call/HTTP] end channel=${body.channelName} ender=${enderId} other=${otherId}`);
    return { ok: true };
  }
}
