import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { IsOptional, IsString, IsBoolean, IsNumber } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StoriesService } from './stories.service';

class CreateStoryDto {
  @IsOptional() @IsString()  media_url?: string;
  @IsOptional() @IsBoolean() is_video?: boolean;
  @IsOptional() @IsString()  text?: string;
  @IsOptional() @IsNumber()  text_bg_color_value?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('stories')
export class StoriesController {
  constructor(private readonly storiesService: StoriesService) {}

  @Get('feed')
  async getFeed(@Request() req: any) {
    const stories = await this.storiesService.getFeed(req.user.id);
    return { stories };
  }

  @Post()
  async createStory(@Request() req: any, @Body() dto: CreateStoryDto) {
    const story = await this.storiesService.createStory(req.user.id, dto);
    return { story };
  }

  @Post(':storyId/view')
  async markViewed(@Request() req: any, @Param('storyId') storyId: string) {
    await this.storiesService.markViewed(storyId, req.user.id);
    return { ok: true };
  }

  @Delete(':storyId')
  async deleteStory(@Request() req: any, @Param('storyId') storyId: string) {
    await this.storiesService.deleteStory(storyId, req.user.id);
    return { ok: true };
  }
}
