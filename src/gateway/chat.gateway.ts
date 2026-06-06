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
  // Server → Client
  NEW_MSG:          'new_message',
  MSG_UPDATED:      'message_updated',
  MSG_DELETED:      'message_deleted',
  USER_TYPING:      'user_typing',
  USER_STOPPED:     'user_stopped_typing',
  USER_ONLINE:      'user_online',
  USER_OFFLINE:     'user_offline',
  MSG_SEEN:         'message_seen',
  NEW_NOTIFICATION: 'new_notification',
  DELIVERED:        'delivered',
  // Server → Client: call signaling
  INCOMING_CALL:   'incoming_call',
  CALL_ACCEPTED:   'call_accepted',
  CALL_REJECTED:   'call_rejected',
  CALL_CANCELLED:  'call_cancelled',
  CALL_ENDED:      'call_ended',
} as const;

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/',
})
@Injectable()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  // userId → Set<socketId>  (one user can have multiple tabs/devices)
  private readonly userSockets = new Map<string, Set<string>>();

  // channelName → { callerId, calleeId }  — cleared when call ends/is rejected/cancelled
  private readonly callSessions = new Map<string, { callerId: string; calleeId: string }>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly messages: MessagesService,
    private readonly chats: ChatsService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly fcm: FcmService,
  ) {}

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async handleConnection(socket: Socket) {
    const userId = await this.authenticate(socket);
    if (!userId) return socket.disconnect();

    socket.data.userId = userId;
    this.trackSocket(userId, socket.id);

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
      // Mark messages delivered on join
      await this.messages.markDelivered(data.chatId, userId);
    } catch {
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
    console.log(`[Call] call_invite from=${callerId} to=${data.targetUserId} online=${calleeOnline} channel=${data.channelName}`);
    this.callSessions.set(data.channelName, { callerId, calleeId: data.targetUserId });

    const invitePayload = {
      callerId,
      callerName: data.callerName,
      callerAvatar: data.callerAvatar ?? null,
      channelName: data.channelName,
      callType: data.callType,
    };

    // Always emit via socket (works when callee is connected).
    this.emitToUser(data.targetUserId, SE.INCOMING_CALL, invitePayload);

    // Always also send FCM so the app wakes when backgrounded/killed.
    await this.fcm.notifyCallEvent(data.targetUserId, 'call_invite', {
      callerId,
      callerName: data.callerName,
      callerAvatar: data.callerAvatar ?? '',
      channelName: data.channelName,
      callType: data.callType,
    });
  }

  @SubscribeMessage(SE.CALL_ANSWER)
  onCallAnswer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.get(data.channelName);
    if (!session) return;
    this.emitToUser(session.callerId, SE.CALL_ACCEPTED, { channelName: data.channelName });
  }

  @SubscribeMessage(SE.CALL_REJECT)
  onCallReject(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.get(data.channelName);
    if (!session) return;
    this.emitToUser(session.callerId, SE.CALL_REJECTED, { channelName: data.channelName });
    this.callSessions.delete(data.channelName);
  }

  @SubscribeMessage(SE.CALL_CANCEL)
  onCallCancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.get(data.channelName);
    if (!session) return;
    this.emitToUser(session.calleeId, SE.CALL_CANCELLED, { channelName: data.channelName });
    this.callSessions.delete(data.channelName);
  }

  @SubscribeMessage(SE.CALL_END)
  onCallEnd(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { channelName: string },
  ) {
    const session = this.callSessions.get(data.channelName);
    if (!session) return;
    const enderId = socket.data.userId as string;
    const otherId = enderId === session.callerId ? session.calleeId : session.callerId;
    this.emitToUser(otherId, SE.CALL_ENDED, { channelName: data.channelName });
    this.callSessions.delete(data.channelName);
  }

  // ── Server-initiated push ─────────────────────────────────────────────────

  /** Push an event to a specific user across all their connected sockets. */
  emitToUser(userId: string, event: string, payload: unknown) {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return;
    for (const sid of socketIds) {
      this.server.to(sid).emit(event, payload);
    }
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
