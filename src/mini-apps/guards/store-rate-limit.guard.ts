import {
  CanActivate, ExecutionContext, Injectable,
  HttpException, HttpStatus,
} from '@nestjs/common';

@Injectable()
export class StoreRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 60_000;
  private readonly max = 60;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const key = req.ip ?? 'unknown';

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
