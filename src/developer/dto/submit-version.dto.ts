import { IsString, IsUrl, IsOptional, MaxLength, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ScreenshotDto {
  @IsUrl() url!: string;
  @IsOptional() @IsString() @MaxLength(200) caption?: string;
  @IsOptional() order?: number;
}

export class SubmitVersionDto {
  @IsString() @MaxLength(20) version!: string;
  @IsUrl() appUrl!: string;
  @IsOptional() @IsString() changelog?: string;
  @IsOptional() @IsString() minGoseenVersion?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ScreenshotDto)
  screenshots?: ScreenshotDto[];
}
