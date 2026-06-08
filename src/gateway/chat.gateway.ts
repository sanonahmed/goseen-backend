import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { MessagesService } from '../messages/messages.service';
import { ChatsService } from '../chats/chats.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { FcmService } from '../fcm/fcm.service';
import { CallSessionStore } from '../call/call-session.store';

// ── Socket event constants ────────────────────────────────────────────────────
// Must match lib/core/network/socket_service.dart in Flutter
export const SE = {
  // Client → Server
  JOIN_ROOM:   'join_room',
  LEAVE_ROOM:  'leave_room',
  SEND_MSG:    'send_message',
  TYPING:      'typing',
  STOP_TYPING: 'stop_typing',
  MARK_SEEN:   'mark_seen',
  // Client → Server: call signaling
  CALL_INVITE:  'call_invite',
  CALL_CANCEL:  'call_cancel',
  CALL_ANSWER:  'call_answer',
  CALL_REJECT:  'call_reject',
  CALL_END:     'call_end',
  // Client → Server: reactions (socket path — avoids HTTP round-trip latency)
  TOGGLE_REACTION: 'toggle_reaction',
  // Client → Server: mid-call video upgrade
  VIDEO_UPGRADE_REQ: 'video_upgrade_req',  // requester → server → target
  VIDEO_UPGRADE_RES: 'video_upgrade_res',  // responder → server → requester
  // Server → Client
  NEW_MSG:          'new_message',
  MSG_UPDATED:      'message_updated',
  MSG_DELETED:      'message_deleted',
  USER_TYPING:      'user_typing',
  USER_STOPPED:     'user_stopped_typing',
  USER_ONLINE:      'user_online',
  USER_OFFLINE:     'user_offline',
  MSG_SEEN:         'message_seen',
  NEW_NOTIFICATION:     'new_notification',
  CONNECTION_REQUEST:   'connection_request',
  DELIVERED:        'delivered',
  // Server → Client: call signaling
  INCOMING_CALL:   'incoming_call',
  CALL_ACCEPTED:   'call_accepted',
  CALL_REJECTED:   'call_rejected',
  CALL_CANCELLED:  'call_cancelled',
  CALL_ENDED:      'call_ended',
  // Server → Client: mid-call video upgrade
  VIDEO_UPGRADE_REQUEST:  'video_upgrade_request',
  VIDEO_UPGRADE_ACCEPTED: 'video_upgrade_accepted',
  VIDEO_UPGRADE_DECLINED: 'video_upgrade_declined',
} as const;

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/',
})
@Injectable()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  // Kept for isUserOnline check only; emitToUser now uses 'user:{id}' rooms.
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly messages: MessagesService,
    private readonly chats: ChatsService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly fcm: FcmService,
    private readonly callSessions: CallSessionStore,
  ) {}

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async handleConnection(socket: Socket) {
    const userId = await this.authenticate(socket);
    if (!userId) {
      console.warn(`[Socket] connection rejected — no valid token sid=${socket.id}`);
      return socket.disconnect();
    }

    socket.data.userId = userId;
    this.trackSocket(userId, socket.id);
    // Each socket joins a personal room so emitToUser can target all of a
    // user's devices without maintaining a manual socket-ID Map.
    await socket.join(`user:${userId}`);

    // Auto-join all the user's chat rooms so new_message events reach the
    // home screen even when no specific chat screen is open.
    try {
      const { rows } = await this.pool.query<{ chat_id: string }>(
        'SELECT chat_id FROM chat_members WHERE user_id = $1',
        [userId],
      );
      await Promise.all(rows.map((r) => socket.join(`chat:${r.chat_id}`)));
      console.log(`[Socket] connected userId=${userId} sid=${socket.id} transport=${socket.conn.transport.name} autoJoined=${rows.length} rooms`);
    } catch (err) {
      console.error(`[Socket] auto-join rooms failed userId=${userId}: ${err}`);
      console.log(`[Socket] connected userId=${userId} sid=${socket.id} transport=${socket.conn.transport.name}`);
    }

    await this.users.setOnlineStatus(userId, true);
    this.broadcastPresence(userId, true);
  }

  async handleDisconnect(socket: Socket) {
    const userId: string | undefined = socket.data.userId;
    if (!userId) return;

    this.untrackSocket(userId, socket.id);

    // Only broadcast offline when last device disconnects
    if (!this.userSockets.get(userId)?.size) {
      await this.users.setOnlineStatus(userId, false);
      // Fetch the timestamp that was just written so the client gets the exact value.
      const lastSeen = await this.users.getLastSeen(userId);
      this.broadcastPresence(userId, false, lastSeen);
    }
  }

  // ── Room management ───────────────────────────────────────────────────────

  @SubscribeMessage(SE.JOIN_ROOM)
  async onJoinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatId: string },
  ) {
    const { userId } = socket.data;
    try {
      await this.chats.assertMember(data.chatId, userId);
      await socket.join(`chat:${data.chatId}`);
      const roomSize = this.server.sockets.adapter.rooms.get(`chat:${data.chatId}`)?.size ?? 0;
      console.log(`[Room] user=${userId} joined chat:${data.chatId} roomSize=${roomSize}`);
      await this.messages.markDelivered(data.chatId, userId);
    } catch (err) {
      console.error(`[Room] join FAILED user=${userId} chat=${data.chatId} err=${err}`);
      throw new WsException('Forbidden');
    }
  }

  @SubscribeMessage(SE.LEAVE_ROOM)
  async onLeaveRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatId: string },
  ) {
    await socket.leave(`chat:${data.chatId}`);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  @SubscribeMessage(SE.SEND_MSG)
  async onSendMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      chatId: string;
      text?: string;
      type?: string;
      media_url?: string;
      media_file_id?: string;
      reply_to_id?: string;
      voice_duration?: number;
    },
  ) {
    const { userId } = socket.data;

    let msg: any;
    try {
      msg = await this.messages.sendMessage(data.chatId, userId, {
        text: data.text,
        type: data.type,
        media_url: data.media_url,
        media_file_id: data.media_file_id,
        reply_to_id: data.reply_to_id,
        voice_duration: data.voice_duration,
      });
    } catch {
      throw new WsException('Failed to send message');
    }

    // Broadcast to chat room (all members including sender)
    this.server.to(`chat:${data.chatId}`).emit(SE.NEW_MSG, {
      ...msg,
      chat_id: data.chatId,
    });

    // Notify offline members via in-app notification record
    await this.notifyOfflineMembers(data.chatId, userId, msg);

    return { event: 'message_sent', data: { id: msg.id } };
  }

  // ── Typing indicators ─────────────────────────────────────────────────────

  @SubscribeMessage(SE.TYPING)
  onTyping(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatId: string },
  ) {
    socket.to(`chat:${data.chatId}`).emit(SE.USER_TYPING, {
      chatId: data.chatId,
      userId: socket.data.userId,
    });
  }

  @SubscribeMessage(SE.STOP_TYPING)
  onStopTyping(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatId: string },
  ) {
    socket.to(`chat:${data.chatId}`).emit(SE.USER_STOPPED, {
      chatId: data.chatId,
      userId: socket.data.userId,
    });
  }

  // ── Seen receipts ─────────────────────────────────────────────────────────

  @SubscribeMessage(SE.MARK_SEEN)
  async onMarkSeen(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatId: string; messageId: string },
  ) {
    const { userId } = socket.data;
    await this.messages.markSeen(data.chatId, userId);
    await this.chats.markSeen(data.chatId, userId);

    // Notify sender that their message was seen
    socket.to(`chat:${data.chatId}`).emit(SE.MSG_SEEN, {
      chatId: data.chatId,
      messageId: data.messageId,
      seenBy: userId,
    });
  }

  // ── Call signaling ────────────────────────────────────────────────────────

  @SubscribeMessage(SE.CALL_INVITE)
  async onCallInvite(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      targetUserId: string;
      channelName: string;
      callerName: string;
      callerAvatar?: string;
      callType: string;
    },
  ) {
    const callerId = socket.data.userId as string;
    const calleeOnline = (this.userSockets.get(data.targetUserId)?.size ?? 0) > 0;
    console.log(`[Call/WS] invite from=${callerId} to=${data.targetUserId} online=${calleeOnline} channel=${data.channelName}`);

    this.callSessions.set(data.channelName, {
      callerId,
      calleeId: data.targetUserId,
      callType: data.callType,
      callerName: data.callerName,
      status: 'ringing',
      startedAt: new Date(),
    });

    const invitePayload = {
      callerId,
      callerName: data.callerName,
      callerAvatar: data.callerAvatar ?? null,
      channelName: data.channelName,
      callType: data.callType,
    };

    this.emitToUser(data.targetUserId, SE.INCOMING_CALL, invitePayload);
    await this.fcm.notifyCallEvent(data.targetUserId, 'call_invite', {
      callerId,
      callerName: data.callerName,
      callerAvatar: data.callerAvatar ?? '',
      channelName: data.channelName,
      callType: data.callType,
    });
  }

  @SubscribeMessage(SE.CALL_ANSWER)
  async onCallAnswer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string; callerId?: string },
  ) {
    const calleeId = socket.data.userId as string;
    const session  = this.callSessions.get(data.channelName);
    // Use session callerId first; fall back to the callerId the callee sent
    // in the payload (resilient against backend restarts losing in-memory state).
    const callerId = session?.callerId ?? data.callerId;

    const callerSocketCount = this.userSockets.get(callerId ?? '')?.size ?? 0;
    console.log(
      `[Call/WS] call_answer channel=${data.channelName} callee=${calleeId}` +
      ` session=${session ? 'found' : 'MISSING'} callerId=${callerId ?? 'unknown'}` +
      ` callerSockets=${callerSocketCount}`,
    );

    if (!callerId) {
      console.warn(`[Call/WS] call_answer – no callerId for channel=${data.channelName}, dropping`);
      return;
    }

    if (session) this.callSessions.markActive(data.channelName);

    // Always emit via socket — fast path.
    this.emitToUser(callerId, SE.CALL_ACCEPTED, { channelName: data.channelName });
    console.log(`[Call/WS] call_accepted socket emitted to callerId=${callerId} (sockets=${callerSocketCount})`);

    // FCM backup: ensures delivery even if caller's socket briefly loses
    // its tracking entry (Railway proxy reconnect, pod restart, etc.).
    await this.fcm.notifyCallEvent(callerId, 'call_accept', {
      channelName: data.channelName,
    });
  }

  @SubscribeMessage(SE.CALL_REJECT)
  onCallReject(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.delete(data.channelName);
    if (!session) return;
    this.emitToUser(session.callerId, SE.CALL_REJECTED, { channelName: data.channelName });
  }

  @SubscribeMessage(SE.CALL_CANCEL)
  onCallCancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.delete(data.channelName);
    if (!session) return;
    this.emitToUser(session.calleeId, SE.CALL_CANCELLED, { channelName: data.channelName });
  }

  @SubscribeMessage(SE.CALL_END)
  onCallEnd(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.delete(data.channelName);
    if (!session) return;
    const enderId = socket.data.userId as string;
    const otherId = enderId === session.callerId ? session.calleeId : session.callerId;
    this.emitToUser(otherId, SE.CALL_ENDED, { channelName: data.channelName });
  }

  @SubscribeMessage(SE.VIDEO_UPGRADE_REQ)
  onVideoUpgradeReq(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string; targetUserId: string },
  ) {
    const session = this.callSessions.get(data.channelName);
    const requesterName = session?.callerName ?? 'Unknown';
    this.emitToUser(data.targetUserId, SE.VIDEO_UPGRADE_REQUEST, {
      channelName: data.channelName,
      requesterName,
    });
    console.log(`[Call/WS] video_upgrade_req channel=${data.channelName} target=${data.targetUserId}`);
  }

  @SubscribeMessage(SE.VIDEO_UPGRADE_RES)
  onVideoUpgradeRes(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string; requesterId: string; accepted: boolean },
  ) {
    const event = data.accepted ? SE.VIDEO_UPGRADE_ACCEPTED : SE.VIDEO_UPGRADE_DECLINED;
    this.emitToUser(data.requesterId, event, { channelName: data.channelName });
    if (data.accepted) {
      const session = this.callSessions.get(data.channelName);
      if (session) session.callType = 'video';
    }
    console.log(`[Call/WS] video_upgrade_res channel=${data.channelName} accepted=${data.accepted}`);
  }

  // ── Reactions (socket path) ───────────────────────────────────────────────

  @SubscribeMessage(SE.TOGGLE_REACTION)
  onToggleReaction(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      chatId: string;
      messageId: string;
      emoji: string;
      remove: boolean;
      reactions: Array<{ emoji: string; count: number }>;
    },
  ) {
    const userId = socket.data.userId as string;
    const roomName = `chat:${data.chatId}`;
    const roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size ?? 0;
    console.log(`[Reaction] toggle_reaction from=${userId} room=${roomName} roomSize=${roomSize} emoji=${data.emoji} remove=${data.remove}`);

    // Phase 1 — Immediate optimistic broadcast (zero DB reads).
    // Uses client-supplied counts so both users see the reaction instantly.
    const optimisticReactions = Array.isArray(data.reactions) ? data.reactions : [];
    this.server.to(roomName).emit('reaction_added', {
      chat_id: data.chatId,
      message_id: data.messageId,
      reactions: optimisticReactions,
    });
    console.log(`[Reaction] optimistic broadcast done to ${roomSize} sockets`);

    // Phase 2 — Persist to DB, then send per-user confirmed reactions.
    // Per-user emission includes reacted_by_me so each client knows whether
    // THEY reacted, without relying on local-state fallbacks.
    (data.remove
      ? this.messages.removeReaction(data.messageId, userId, data.emoji)
      : this.messages.addReaction(data.messageId, userId, data.emoji)
    ).then(async () => {
      const memberIds = await this.chats.getMemberIds(data.chatId);
      await Promise.all(
        memberIds.map(async (memberId) => {
          const reactions = await this.messages.getReactionsForMessage(data.messageId, memberId);
          this.emitToUser(memberId, 'reaction_added', {
            chat_id: data.chatId,
            message_id: data.messageId,
            reactions,
          });
        }),
      );
      console.log(`[Reaction] confirmed per-user broadcast done for ${memberIds.length} members`);
    }).catch((err) => {
      console.error(`[Reaction] DB persist/confirm failed: ${err}`);
    });
  }

  // ── Server-initiated push ─────────────────────────────────────────────────

  /** Push an event to a specific user across all their connected sockets.
   *  Uses the 'user:{id}' personal room — more reliable than a manual socket
   *  ID Map because Socket.IO manages room membership internally and there is
   *  no stale-entry gap when the user reconnects.
   */
  emitToUser(userId: string, event: string, payload: unknown) {
    const room = `user:${userId}`;
    const roomSize = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    if (roomSize === 0) {
      console.warn(`[Gateway] emitToUser – user=${userId} has NO connected sockets, event=${event} dropped`);
      return;
    }
    console.log(`[Gateway] emitToUser userId=${userId} event=${event} sockets=${roomSize}`);
    this.server.to(room).emit(event, payload);
  }

  emitToChat(chatId: string, event: string, payload: unknown) {
    this.server.to(`chat:${chatId}`).emit(event, payload);
  }

  isUserOnline(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async authenticate(socket: Socket): Promise<string | null> {
    const token =
      (socket.handshake.auth as any)?.token ??
      socket.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) return null;
    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      }) as { sub: string };
      return payload.sub;
    } catch {
      return null;
    }
  }

  private trackSocket(userId: string, socketId: string) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);
  }

  private untrackSocket(userId: string, socketId: string) {
    this.userSockets.get(userId)?.delete(socketId);
  }

  private broadcastPresence(userId: string, isOnline: boolean, lastSeen?: Date) {
    const event = isOnline ? SE.USER_ONLINE : SE.USER_OFFLINE;
    this.server.emit(event, {
      userId,
      ...(lastSeen && { last_seen: lastSeen.toISOString() }),
    });
  }

  private async notifyOfflineMembers(
    chatId: string,
    senderId: string,
    message: any,
  ) {
    const { rows: members } = await this.pool.query(
      `SELECT cm.user_id
       FROM chat_members cm
       WHERE cm.chat_id = $1 AND cm.user_id != $2`,
      [chatId, senderId],
    );

    for (const member of members) {
      if (!this.isUserOnline(member.user_id)) {
        await this.notifications.create({
          recipientId: member.user_id,
          actorId: senderId,
          type: 'new_message',
          title: message.sender_name ?? 'New message',
          body: message.text ?? '📎 Media',
          data: { chatId, messageId: message.id },
        });
      }
    }
  }
}
