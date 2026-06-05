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

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly messages: MessagesService,
    private readonly chats: ChatsService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
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
      this.broadcastPresence(userId, false);
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

  private broadcastPresence(userId: string, isOnline: boolean) {
    const event = isOnline ? SE.USER_ONLINE : SE.USER_OFFLINE;
    // Broadcast to all sockets in rooms where this user is a member
    // Simple approach: broadcast globally; clients filter by contact list
    this.server.emit(event, { userId });
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
