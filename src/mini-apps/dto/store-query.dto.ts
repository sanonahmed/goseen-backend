import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export const CATEGORIES = [
  'games', 'utilities', 'social', 'productivity', 'finance',
  'health', 'education', 'entertainment', 'business', 'other',
] as const;

export const SORT_OPTIONS = ['trending', 'rating', 'installs', 'recent'] as const;

export class StoreQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsIn(SORT_OPTIONS) sort?: string = 'trending';
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number = 20;
}
