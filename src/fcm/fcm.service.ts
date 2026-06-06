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

      // call_invite  → visible notification to wake/alert the callee.
      // missed_call  → visible persistent notification in the callee's tray.
      // everything else → data-only so the app handles it silently.
      const isInvite = type === 'call_invite';
      const isMissed = type === 'missed_call';
      const inviteTitle = `${data['callerName'] ?? 'Someone'} is calling`;
      const inviteBody =
        data['callType'] === 'video' ? 'Incoming video call' : 'Incoming voice call';
      const missedTitle = `Missed ${data['callType'] === 'video' ? 'video' : 'voice'} call`;
      const missedBody  = `${data['callerName'] ?? 'Someone'} called`;

      await admin.messaging().send({
        token,
        data: { type, ...data },
        ...(isInvite
          ? {
              // Android: data-only high-priority wake — our Flutter background handler
              // shows a full-screen local notification with Accept/Decline buttons.
              // iOS: visible via APS alert so the system shows it on the lock screen
              // until CallKit (Phase 3.2) replaces this path entirely.
              android: { priority: 'high' },
              apns: {
                headers: { 'apns-priority': '10' },
                payload: {
                  aps: {
                    alert: { title: inviteTitle, body: inviteBody },
                    sound: 'default',
                    contentAvailable: true,
                  },
                },
              },
            }
          : isMissed
          ? {
              // Missed call: visible persistent notification, no sound.
              notification: { title: missedTitle, body: missedBody },
              android: {
                priority: 'high',
                notification: { channelId: 'goseen_calls' },
              },
              apns: {
                headers: { 'apns-priority': '5' },
                payload: { aps: { contentAvailable: true } },
              },
            }
          : {
              // All other call events: data-only, high priority to wake background app.
              android: { priority: 'high' },
              apns: {
                headers: { 'apns-priority': '10' },
                payload: { aps: { contentAvailable: true } },
              },
            }),
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
