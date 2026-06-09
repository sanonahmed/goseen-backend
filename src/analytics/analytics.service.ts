import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { AnalyticsEventDto } from './dto/batch-events.dto';

interface BufferedEvent {
  miniAppId: string;
  userId: string | null;
  eventType: string;
  eventName: string | null;
  eventData: Record<string, unknown>;
  sessionId: string | null;
  platform: string | null;
  appVersion: string | null;
  goseenVersion: string | null;
  durationMs: number | null;
  createdAt: Date;
}

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  onModuleInit() {
    this.flushTimer = setInterval(() => this.flush(), 5000);
  }

  onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush(); // flush remaining events on shutdown
  }

  enqueue(events: AnalyticsEventDto[], userId?: string): void {
    for (const e of events) {
      this.buffer.push({
        miniAppId: e.miniAppId,
        userId: userId ?? null,
        eventType: e.eventType,
        eventName: e.eventName ?? null,
        eventData: e.eventData ?? {},
        sessionId: e.sessionId ?? null,
        platform: e.platform ?? null,
        appVersion: e.appVersion ?? null,
        goseenVersion: e.goseenVersion ?? null,
        durationMs: e.durationMs ?? null,
        createdAt: new Date(),
      });
    }

    // Flush immediately if buffer hits 500 events
    if (this.buffer.length >= 500) this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      // Build parameterised bulk insert
      const valueClauses: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      for (const e of batch) {
        valueClauses.push(
          `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`,
        );
        params.push(
          e.miniAppId, e.userId, e.eventType, e.eventName,
          JSON.stringify(e.eventData), e.sessionId, e.platform,
          e.appVersion, e.goseenVersion, e.durationMs, e.createdAt,
        );
      }

      await this.pool.query(
        `INSERT INTO analytics_events
           (mini_app_id, user_id, event_type, event_name, event_data,
            session_id, platform, app_version, goseen_version, duration_ms, created_at)
         VALUES ${valueClauses.join(',')}`,
        params,
      );
    } catch (err) {
      console.error('[Analytics] flush failed, events discarded:', err);
    }
  }
}
