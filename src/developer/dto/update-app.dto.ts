import {
  IsString, MaxLength, IsIn, IsOptional, IsUrl, IsArray, IsString as IsStr,
} from 'class-validator';
import { CATEGORIES } from '../../mini-apps/dto/store-query.dto';

export class UpdateAppDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(200) shortDescription?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: string;
  @IsOptional() @IsArray() @IsStr({ each: true }) tags?: string[];
  @IsOptional() @IsUrl() privacyPolicyUrl?: string;
  @IsOptional() @IsUrl() termsUrl?: string;
  @IsOptional() @IsUrl() supportUrl?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsArray() @IsStr({ each: true }) allowedDomains?: string[];
  @IsOptional() @IsUrl() iconUrl?: string;
  @IsOptional() @IsUrl() bannerUrl?: string;
}
