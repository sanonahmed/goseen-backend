import {
  CanActivate, ExecutionContext, Injectable,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class BridgeRateLimitGuard implements CanActivate {
  // In-memory sliding window. Replace Map values with Redis INCR for multi-instance.
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 60_000;
  private readonly max = 30;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Key per API key (hashed) so different developers have independent quotas.
    // Falls back to IP for requests without an auth header.
    const auth: string = req.headers?.authorization ?? '';
    const rawKey = auth.replace(/^Bearer\s+/i, '').trim();
    const key = rawKey
      ? createHash('sha256').update(rawKey).digest('hex').slice(0, 16)
      : (req.ip ?? 'unknown');

    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length >= this.max) {
      const retryAfter = Math.ceil((recent[0] + this.windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { statusCode: 429, message: 'Too many requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
