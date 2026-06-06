import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as admin from 'firebase-admin';
import { DB_POOL } from '../database/database.module';

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private ready = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  onModuleInit() {
    const raw = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT');
    if (!raw) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled',
      );
      return;
    }
    try {
      // Avoid re-initialising on hot reload.
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(raw)),
        });
      }
      this.ready = true;
      this.logger.log('Firebase Admin SDK initialised');
    } catch (err) {
      this.logger.error('Firebase Admin init failed', err);
    }
  }

  /**
   * Send a high-priority FCM call signaling event to a single user.
   * type: 'call_invite' | 'call_cancel' | 'call_accept' | 'call_reject' | 'call_end'
   * Fire-and-forget.
   */
  async notifyCallEvent(
    userId: string,
    type: string,
    data: Record<string, string>,
  ): Promise<void> {
    if (!this.ready) return;
    try {
      const { rows } = await this.pool.query<{ fcm_token: string | null }>(
        `SELECT fcm_token FROM users WHERE id = $1`,
        [userId],
      );
      const token = rows[0]?.fcm_token;
      if (!token) return;

      const notifTitle =
        type === 'call_invite'
          ? `${data['callerName'] ?? 'Someone'} is calling`
          : type === 'call_accept'
            ? 'Call accepted'
            : type === 'call_reject'
              ? 'Call declined'
              : type === 'call_cancel'
                ? 'Call cancelled'
                : 'Call ended';

      const notifBody =
        type === 'call_invite'
          ? data['callType'] === 'video'
            ? 'Incoming video call'
            : 'Incoming voice call'
          : '';

      await admin.messaging().send({
        token,
        ...(notifBody
          ? { notification: { title: notifTitle, body: notifBody } }
          : { notification: { title: notifTitle } }),
        data: { type, ...data },
        android: {
          priority: 'high',
          notification: {
            channelId: 'goseen_calls',
            sound: 'default',
            priority: 'max',
            defaultVibrateTimings: true,
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', contentAvailable: true } },
        },
      });
    } catch (err) {
      this.logger.error(`FCM ${type} failed`, err);
    }
  }

  /**
   * Send a push notification to all chat members except the sender.
   * Fire-and-forget — never throws.
   */
  async notifyMessageRecipients(
    chatId: string,
    senderId: string,
    payload: { title: string; body: string },
  ): Promise<void> {
    if (!this.ready) return;
    try {
      const { rows } = await this.pool.query<{ fcm_token: string | null }>(
        `SELECT u.fcm_token
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = $1
           AND cm.user_id != $2
           AND u.fcm_token IS NOT NULL`,
        [chatId, senderId],
      );

      const tokens = rows
        .map((r) => r.fcm_token)
        .filter((t): t is string => !!t);
      if (tokens.length === 0) return;

      const results = await Promise.allSettled(
        tokens.map((token) =>
          admin.messaging().send({
            token,
            notification: { title: payload.title, body: payload.body },
            data: { chat_id: chatId },
            android: {
              priority: 'high',
              notification: { channelId: 'goseen_messages' },
            },
            apns: {
              headers: { 'apns-priority': '10' },
              payload: { aps: { sound: 'default', contentAvailable: true } },
            },
          }),
        ),
      );

      // Remove stale tokens (no-registration / invalid-registration)
      const staleTokens: string[] = [];
      results.forEach((r, i) => {
        if (
          r.status === 'rejected' &&
          (r.reason?.errorInfo?.code ===
            'messaging/registration-token-not-registered' ||
            r.reason?.errorInfo?.code ===
              'messaging/invalid-registration-token')
        ) {
          staleTokens.push(tokens[i]);
        }
      });
      if (staleTokens.length) {
        await this.pool.query(
          'UPDATE users SET fcm_token = NULL WHERE fcm_token = ANY($1)',
          [staleTokens],
        );
      }
    } catch (err) {
      this.logger.error('FCM send failed', err);
    }
  }
}
