import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  OnModuleInit,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Pool } from 'pg';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DB_POOL } from '../database/database.module';
import { ChatGateway } from '../gateway/chat.gateway';
import { FcmService } from '../fcm/fcm.service';
import { CallSessionStore } from './call-session.store';
import { SE } from '../gateway/chat.gateway';

interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

@Controller('call')
@UseGuards(JwtAuthGuard)
export class CallController implements OnModuleInit {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly fcm: FcmService,
    private readonly sessions: CallSessionStore,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  // Ensure the call_logs table exists before any endpoint is hit.
  async onModuleInit() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id               SERIAL PRIMARY KEY,
        channel_name     TEXT UNIQUE NOT NULL,
        caller_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        callee_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        call_type        TEXT NOT NULL DEFAULT 'audio',
        status           TEXT NOT NULL,
        duration_seconds INTEGER,
        started_at       TIMESTAMPTZ NOT NULL,
        ended_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  // ── invite ────────────────────────────────────────────────────────────────

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

    // Step 4.5 — rate limiting: max 3 unanswered invites per 5 minutes.
    if (!this.sessions.canInvite(callerId, body.targetUserId)) {
      // Return ok:false (200) so the Flutter client can show a friendly message
      // without Dio throwing on a 4xx.
      return { ok: false, reason: 'rate_limited' };
    }

    this.sessions.set(body.channelName, {
      callerId,
      calleeId: body.targetUserId,
      callType: body.callType,
      callerName: body.callerName,
      status: 'ringing',
      startedAt: new Date(),
    });

    const payload = {
      callerId,
      callerName: body.callerName,
      callerAvatar: body.callerAvatar ?? '',
      channelName: body.channelName,
      callType: body.callType,
    };

    this.gateway.emitToUser(body.targetUserId, SE.INCOMING_CALL, payload);
    await this.fcm.notifyCallEvent(body.targetUserId, 'call_invite', payload);

    console.log(`[Call/HTTP] invite from=${callerId} to=${body.targetUserId} channel=${body.channelName}`);
    return { ok: true };
  }

  // ── cancel (caller hangs up before answer) ────────────────────────────────

  @Post('cancel')
  async cancel(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; calleeId?: string },
  ) {
    const session = this.sessions.delete(body.channelName);
    const calleeId = body.calleeId ?? session?.calleeId;

    if (!calleeId) {
      console.warn(`[Call/HTTP] cancel – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    // Free the rate-limit slot so a manual cancel doesn't permanently burn a slot.
    if (session) this.sessions.clearInviteSlot(session.callerId, calleeId);

    this.gateway.emitToUser(calleeId, SE.CALL_CANCELLED, { channelName: body.channelName });
    await this.fcm.notifyCallEvent(calleeId, 'call_cancel', { channelName: body.channelName });

    if (session?.status === 'ringing') {
      await this._recordMissedCall(session, body.channelName);
    }

    console.log(`[Call/HTTP] cancel channel=${body.channelName} callee=${calleeId}`);
    return { ok: true };
  }

  // ── answer (callee accepts) ───────────────────────────────────────────────

  @Post('answer')
  async answer(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; callerId?: string },
  ) {
    const session = this.sessions.get(body.channelName);
    const callerId = body.callerId ?? session?.callerId;

    if (!callerId) {
      console.warn(`[Call/HTTP] answer – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    this.sessions.markActive(body.channelName);

    // Notify the caller that the call was accepted.
    console.log(`[Call/HTTP] answer – emitting call_accepted to callerId=${callerId} channel=${body.channelName}`);
    this.gateway.emitToUser(callerId, SE.CALL_ACCEPTED, { channelName: body.channelName });
    await this.fcm.notifyCallEvent(callerId, 'call_accept', { channelName: body.channelName });

    // Step 4.3 — stop ringing on all OTHER callee devices.
    // The answering device is already in connecting/active state and will
    // safely ignore this event (Flutter guards on status == ringing).
    const calleeId = session?.calleeId ?? req.user.id;
    this.gateway.emitToUser(calleeId, SE.CALL_CANCELLED, {
      channelName: body.channelName,
      reason: 'answered_elsewhere',
    });
    await this.fcm.notifyCallEvent(calleeId, 'call_cancel', {
      channelName: body.channelName,
      reason: 'answered_elsewhere',
    });

    // Free the rate-limit slot — the call was answered, not unanswered.
    if (session) this.sessions.clearInviteSlot(session.callerId, calleeId);

    console.log(`[Call/HTTP] answer complete channel=${body.channelName} caller=${callerId} callee=${calleeId}`);
    return { ok: true };
  }

  // ── reject (callee declines) ──────────────────────────────────────────────

  @Post('reject')
  async reject(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; callerId?: string },
  ) {
    const session = this.sessions.delete(body.channelName);
    const callerId = body.callerId ?? session?.callerId;

    if (!callerId) {
      console.warn(`[Call/HTTP] reject – no session for channel=${body.channelName}`);
      return { ok: true };
    }

    // Free the rate-limit slot — explicit reject is not an "unanswered" call.
    if (session) this.sessions.clearInviteSlot(session.callerId, session.calleeId);

    this.gateway.emitToUser(callerId, SE.CALL_REJECTED, { channelName: body.channelName });
    await this.fcm.notifyCallEvent(callerId, 'call_reject', { channelName: body.channelName });

    if (session) await this._recordRejectedCall(session, body.channelName);

    console.log(`[Call/HTTP] reject channel=${body.channelName} caller=${callerId}`);
    return { ok: true };
  }

  // ── end (either party hangs up during active call) ────────────────────────

  @Post('end')
  async end(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; otherUserId?: string },
  ) {
    const enderId = req.user.id;
    const session = this.sessions.delete(body.channelName);

    let otherId = body.otherUserId;
    if (!otherId && session) {
      otherId = enderId === session.callerId ? session.calleeId : session.callerId;
    }

    if (otherId) {
      this.gateway.emitToUser(otherId, SE.CALL_ENDED, { channelName: body.channelName });
      await this.fcm.notifyCallEvent(otherId, 'call_end', { channelName: body.channelName });
    } else {
      console.warn(`[Call/HTTP] end – no session for channel=${body.channelName}`);
    }

    if (session?.status === 'ringing') {
      const calleeId = session.calleeId;
      if (calleeId !== enderId) {
        await this._recordMissedCall(session, body.channelName);
      }
    }

    if (session?.status === 'active') {
      await this._recordEndedCall(session, body.channelName);
    }

    console.log(`[Call/HTTP] end channel=${body.channelName} ender=${enderId} other=${otherId}`);
    return { ok: true };
  }

  // ── video upgrade request ─────────────────────────────────────────────────

  @Post('video-upgrade-request')
  videoUpgradeRequest(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; targetUserId: string },
  ) {
    const session = this.sessions.get(body.channelName);
    const requesterName =
      session?.callerName ?? req.user.id;

    const payload = { channelName: body.channelName, requesterName };
    this.gateway.emitToUser(body.targetUserId, SE.VIDEO_UPGRADE_REQUEST, payload);
    // FCM backup: ensures delivery even if socket tracking was lost.
    this.fcm.notifyCallEvent(body.targetUserId, 'video_upgrade_request', {
      channelName: body.channelName,
      requesterName,
    });
    console.log(`[Call/HTTP] video-upgrade-request channel=${body.channelName} target=${body.targetUserId}`);
    return { ok: true };
  }

  // ── video upgrade response (accept / decline) ─────────────────────────────

  @Post('video-upgrade-response')
  videoUpgradeResponse(
    @Req() req: AuthedRequest,
    @Body() body: { channelName: string; requesterId: string; accepted: boolean },
  ) {
    const event = body.accepted ? SE.VIDEO_UPGRADE_ACCEPTED : SE.VIDEO_UPGRADE_DECLINED;
    this.gateway.emitToUser(body.requesterId, event, { channelName: body.channelName });
    if (body.accepted) {
      const session = this.sessions.get(body.channelName);
      if (session) session.callType = 'video';
    }
    const fcmType = body.accepted ? 'video_upgrade_accepted' : 'video_upgrade_declined';
    this.fcm.notifyCallEvent(body.requesterId, fcmType, {
      channelName: body.channelName,
    });
    console.log(`[Call/HTTP] video-upgrade-response channel=${body.channelName} accepted=${body.accepted}`);
    return { ok: true };
  }

  // ── call status (polling fallback for callee-answered detection) ─────────

  @Get('status')
  getStatus(@Query('channelName') channelName: string) {
    if (!channelName) return { status: 'not_found' };
    const session = this.sessions.get(channelName);
    if (!session) return { status: 'not_found' };
    return { status: session.status };
  }

  // ── Step 4.6: recent call logs ────────────────────────────────────────────

  @Get('logs')
  async getLogs(
    @Req() req: AuthedRequest,
    @Query('limit') limitStr?: string,
  ) {
    const userId = req.user.id;
    const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 100);

    const { rows } = await this.pool.query(
      `SELECT
         cl.id,
         cl.channel_name,
         cl.call_type,
         cl.status,
         cl.duration_seconds,
         cl.started_at,
         cl.ended_at,
         cl.caller_id,
         cl.callee_id,
         caller.display_name AS caller_name,
         caller.avatar_url   AS caller_avatar,
         callee.display_name AS callee_name,
         callee.avatar_url   AS callee_avatar
       FROM call_logs cl
       JOIN users caller ON caller.id = cl.caller_id
       JOIN users callee ON callee.id = cl.callee_id
       WHERE cl.caller_id = $1 OR cl.callee_id = $1
       ORDER BY cl.started_at DESC
       LIMIT $2`,
      [userId, limit],
    );

    return rows.map((row) => ({
      id:              row.id,
      channelName:     row.channel_name,
      callType:        row.call_type,
      status:          row.status,
      durationSeconds: row.duration_seconds,
      startedAt:       row.started_at,
      endedAt:         row.ended_at,
      direction:       row.caller_id === userId ? 'outgoing' : 'incoming',
      peerId:          row.caller_id === userId ? row.callee_id   : row.caller_id,
      peerName:        row.caller_id === userId ? row.callee_name : row.caller_name,
      peerAvatar:      row.caller_id === userId ? row.callee_avatar : row.caller_avatar,
    }));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _recordMissedCall(
    session: {
      callerId: string;
      calleeId: string;
      callType: string;
      callerName: string;
      startedAt: Date;
    },
    channelName: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO call_logs
           (channel_name, caller_id, callee_id, call_type, status, started_at, ended_at)
         VALUES ($1, $2, $3, $4, 'missed', $5, NOW())
         ON CONFLICT (channel_name) DO NOTHING`,
        [channelName, session.callerId, session.calleeId, session.callType, session.startedAt],
      );

      await this.fcm.notifyCallEvent(session.calleeId, 'missed_call', {
        callerName: session.callerName,
        callType:   session.callType,
        channelName,
      });
    } catch (err) {
      console.error('[Call] failed to record missed call', err);
    }
  }

  private async _recordRejectedCall(
    session: {
      callerId: string;
      calleeId: string;
      callType: string;
      startedAt: Date;
    },
    channelName: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO call_logs
           (channel_name, caller_id, callee_id, call_type, status, started_at, ended_at)
         VALUES ($1, $2, $3, $4, 'rejected', $5, NOW())
         ON CONFLICT (channel_name) DO NOTHING`,
        [channelName, session.callerId, session.calleeId, session.callType, session.startedAt],
      );
    } catch (err) {
      console.error('[Call] failed to record rejected call', err);
    }
  }

  private async _recordEndedCall(
    session: {
      callerId: string;
      calleeId: string;
      callType: string;
      startedAt: Date;
    },
    channelName: string,
  ): Promise<void> {
    try {
      const durationSecs = Math.round(
        (Date.now() - session.startedAt.getTime()) / 1000,
      );
      await this.pool.query(
        `INSERT INTO call_logs
           (channel_name, caller_id, callee_id, call_type, status,
            duration_seconds, started_at, ended_at)
         VALUES ($1, $2, $3, $4, 'answered', $5, $6, NOW())
         ON CONFLICT (channel_name) DO NOTHING`,
        [
          channelName,
          session.callerId,
          session.calleeId,
          session.callType,
          durationSecs,
          session.startedAt,
        ],
      );
    } catch (err) {
      console.error('[Call] failed to record ended call', err);
    }
  }
}
