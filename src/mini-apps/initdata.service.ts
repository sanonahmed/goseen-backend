import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export interface InitDataPayload {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  miniAppId: string;
  nonce: string;
  authDate: number;
  startParam: string;
  grantedPermissions: string[];
}

export interface UserForSigning {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}

@Injectable()
export class InitDataService implements OnModuleDestroy {
  private readonly signingSecret: string;
  // nonce → expiry timestamp ms. Single-instance safe; swap for Redis on multi-instance.
  private readonly usedNonces = new Map<string, number>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.signingSecret =
      config.get<string>('MINIAPP_SIGNING_SECRET') ?? 'dev-insecure-fallback-secret';
    if (!config.get<string>('MINIAPP_SIGNING_SECRET')) {
      console.warn(
        '[MiniApps] MINIAPP_SIGNING_SECRET not set — using insecure fallback. Set this in production.',
      );
    }
    this.cleanupTimer = setInterval(() => this._purgeExpiredNonces(), 10 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  /** Derive a per-app signing key: HMAC-SHA256(masterSecret, "GoSeen:" + miniAppId) */
  private deriveKey(miniAppId: string): Buffer {
    return createHmac('sha256', this.signingSecret)
      .update(`GoSeen:${miniAppId}`)
      .digest();
  }

  generateNonce(): string {
    return uuidv4();
  }

  /**
   * Signs initData for a user opening a mini app.
   * Returns a URL query string with all fields + hash appended.
   */
  sign(user: UserForSigning, miniAppId: string, grantedPermissions: string[], startParam = ''): string {
    const params: Record<string, string> = {
      auth_date: Math.floor(Date.now() / 1000).toString(),
      granted_permissions: JSON.stringify(grantedPermissions),
      mini_app_id: miniAppId,
      nonce: this.generateNonce(),
      user: JSON.stringify({
        id: user.id,
        username: user.username ?? '',
        display_name: user.display_name ?? '',
        avatar_url: user.avatar_url ?? '',
      }),
    };
    if (startParam) params.start_param = startParam;

    const dataString = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const hash = createHmac('sha256', this.deriveKey(miniAppId))
      .update(dataString)
      .digest('hex');

    return new URLSearchParams({ ...params, hash }).toString();
  }

  /**
   * Verifies a signed initData string.
   * Checks: HMAC signature, auth_date freshness (1 h), nonce not replayed.
   * Returns decoded payload or null on any failure.
   */
  verify(initData: string): InitDataPayload | null {
    try {
      const params = new URLSearchParams(initData);
      const receivedHash = params.get('hash');
      const miniAppId = params.get('mini_app_id');
      if (!receivedHash || !miniAppId) return null;

      // Reject stale tokens (> 1 hour old)
      const authDate = parseInt(params.get('auth_date') ?? '0', 10);
      if (Number.isNaN(authDate) || Date.now() / 1000 - authDate > 3600) return null;

      // Rebuild data string without the hash param
      params.delete('hash');
      const dataString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      // Constant-time HMAC comparison
      const expectedHash = createHmac('sha256', this.deriveKey(miniAppId))
        .update(dataString)
        .digest('hex');

      if (
        receivedHash.length !== expectedHash.length ||
        !timingSafeEqual(Buffer.from(receivedHash, 'hex'), Buffer.from(expectedHash, 'hex'))
      ) {
        return null;
      }

      // Replay prevention: consume nonce (one-time use)
      const nonce = params.get('nonce') ?? '';
      if (!this._consumeNonce(nonce)) return null;

      const user = JSON.parse(params.get('user') ?? '{}');
      return {
        userId: user.id ?? '',
        username: user.username ?? '',
        displayName: user.display_name ?? '',
        avatarUrl: user.avatar_url ?? '',
        miniAppId,
        nonce,
        authDate,
        startParam: params.get('start_param') ?? '',
        grantedPermissions: JSON.parse(params.get('granted_permissions') ?? '[]'),
      };
    } catch {
      return null;
    }
  }

  private _consumeNonce(nonce: string): boolean {
    if (!nonce || this.usedNonces.has(nonce)) return false;
    this.usedNonces.set(nonce, Date.now() + 3_600_000); // expire in 1 hour
    return true;
  }

  private _purgeExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.usedNonces) {
      if (expiry < now) this.usedNonces.delete(nonce);
    }
  }
}
