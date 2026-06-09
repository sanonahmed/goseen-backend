import {
  Controller, Post, Body, HttpCode, HttpStatus, Request,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { BatchEventsDto } from './dto/batch-events.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * POST /api/v1/analytics/events
   * Accepts up to 50 events per call. Auth is optional (user_id recorded when present).
   * Called by the Flutter app (not the JS SDK directly).
   */
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  ingestEvents(@Body() dto: BatchEventsDto, @Request() req: any) {
    const userId: string | undefined = req.user?.id;
    this.analytics.enqueue(dto.events, userId);
    return { accepted: dto.events.length };
  }
}
