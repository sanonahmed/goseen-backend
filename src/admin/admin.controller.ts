import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemService } from '../system/system.service';

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly system: SystemService,
    private readonly config: ConfigService,
  ) {}

  private assertAdmin(authHeader: string | undefined): void {
    const secret = this.config.get<string>('ADMIN_SECRET');
    if (!secret) throw new UnauthorizedException('Admin not configured');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader?.trim();
    if (!token || token !== secret) {
      throw new UnauthorizedException('Invalid admin token');
    }
  }

  /**
   * POST /admin/broadcast
   * Headers: Authorization: Bearer <ADMIN_SECRET>
   * Body:    { "text": "Announcement text" }
   *
   * Sends a message from the GoSeen official account to every user's GoSeen DM.
   */
  @Post('broadcast')
  async broadcast(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { text?: string },
  ) {
    this.assertAdmin(auth);

    const text = body?.text?.trim();
    if (!text) throw new BadRequestException('"text" is required');

    this.logger.log(`Admin broadcast initiated: "${text.slice(0, 80)}…"`);
    const result = await this.system.broadcastAnnouncement(text);
    return { ok: true, sentTo: result.sentTo };
  }
}
