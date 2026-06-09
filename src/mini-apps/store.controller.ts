import {
  Controller, Get, Post, Param, Query, Body,
  UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StoreService } from './store.service';
import { StoreQueryDto } from './dto/store-query.dto';
import { SubmitReviewDto } from './dto/submit-review.dto';

interface OptionalRequest {
  user?: { id: string; email: string };
}

@Controller('miniapps/store')
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get()
  getListing(@Query() query: StoreQueryDto, @Request() req: OptionalRequest) {
    return this.store.getListing(query, req.user?.id);
  }

  @Get('featured')
  getFeatured(@Request() req: OptionalRequest) {
    return this.store.getFeatured(req.user?.id);
  }

  @Get('trending')
  getTrending(@Request() req: OptionalRequest) {
    return this.store.getTrending(req.user?.id);
  }

  @Get('new')
  getNew(@Request() req: OptionalRequest) {
    return this.store.getNew(req.user?.id);
  }

  @Get('categories')
  getCategories() {
    return this.store.getCategories();
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string, @Request() req: OptionalRequest) {
    return this.store.getBySlug(slug, req.user?.id);
  }

  @Get(':slug/reviews')
  getReviews(
    @Param('slug') slug: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('rating') rating?: string,
  ) {
    // We need the app ID from slug — delegate to store service which resolves it
    return this.store.getReviewsBySlug(
      slug,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      rating ? parseInt(rating, 10) : undefined,
    );
  }

  @Post(':slug/reviews')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  submitReview(
    @Param('slug') slug: string,
    @Body() dto: SubmitReviewDto,
    @Request() req: any,
  ) {
    return this.store.submitReviewBySlug(req.user.id, slug, dto);
  }
}
