import { IsInt, Min, Max, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(2000) reviewText?: string;
  @IsOptional() @IsString() versionReviewed?: string;
}
