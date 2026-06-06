import { Injectable, Logger } from '@nestjs/common';

export interface CallSession {
  callerId: string;
  calleeId: string;
  callType: string;
  callerName: string;
  status: 'ringing' | 'active' | 'ended';
  startedAt: Date;
}

/**
 * Single in-memory store for active call sessions shared by both
 * CallController (REST path) and ChatGateway (WebSocket path).
 *
 * Key   = channelName (unique per call, timestamp-scoped)
 * Value = CallSession
 *
 * Replace the Map with a Redis client for multi-instance deployments.
 */
@Injectable()
export class CallSessionStore {
  private readonly logger = new Logger(CallSessionStore.name);
  private readonly sessions = new Map<string, CallSession>();

  // ── Step 4.5: per-caller-per-callee invite rate limiter ───────────────
  // Key = `${callerId}:${calleeId}`, Value = array of epoch-ms timestamps.
  private readonly _inviteTs = new Map<string, number[]>();
  private readonly _rateLimitWindowMs = 5 * 60 * 1000; // 5 minutes
  private readonly _rateLimitMax = 3;                   // max unanswered invites

  /**
   * Returns false (and does NOT record the attempt) if the caller has sent
   * ≥ 3 unanswered invites to the same callee in the last 5 minutes.
   * Records the current timestamp on success.
   */
  canInvite(callerId: string, calleeId: string): boolean {
    const key = `${callerId}:${calleeId}`;
    const now = Date.now();
    const recent = (this._inviteTs.get(key) ?? []).filter(
      (t) => now - t < this._rateLimitWindowMs,
    );
    if (recent.length >= this._rateLimitMax) return false;
    recent.push(now);
    this._inviteTs.set(key, recent);
    return true;
  }

  /**
   * Call this when the callee answers, rejects, or times out so the invite
   * slot is freed.  Removes the oldest recorded timestamp for the pair.
   */
  clearInviteSlot(callerId: string, calleeId: string): void {
    const key = `${callerId}:${calleeId}`;
    const ts = this._inviteTs.get(key);
    if (ts?.length) {
      ts.shift(); // remove the oldest entry
      if (ts.length === 0) this._inviteTs.delete(key);
      else this._inviteTs.set(key, ts);
    }
  }

  // ── Session management ────────────────────────────────────────────────

  set(channelName: string, session: CallSession): void {
    this.sessions.set(channelName, session);
    this.logger.debug(`session created channel=${channelName} caller=${session.callerId}`);
  }

  get(channelName: string): CallSession | undefined {
    return this.sessions.get(channelName);
  }

  markActive(channelName: string): void {
    const s = this.sessions.get(channelName);
    if (s) {
      s.status = 'active';
      this.logger.debug(`session active channel=${channelName}`);
    }
  }

  /** Removes and returns the session, or undefined if not found. */
  delete(channelName: string): CallSession | undefined {
    const s = this.sessions.get(channelName);
    this.sessions.delete(channelName);
    return s;
  }

  isRinging(channelName: string): boolean {
    return this.sessions.get(channelName)?.status === 'ringing';
  }
}
