import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Optional JWT guard: populates req.user if a valid JWT is present,
 * but allows the request through without req.user if JWT is missing or invalid.
 */
@Injectable()
export class JwtOptionalAuthGuard extends AuthGuard('jwt') {
  // Override to prevent Passport from throwing when no/invalid token is present
  handleRequest(_err: any, user: any) {
    return user || null;
  }
}
