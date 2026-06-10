import {
  IsString, MaxLength, IsIn, IsOptional, IsUrl,
  IsArray, ArrayMaxSize, IsBoolean,
} from 'class-validator';
import { CATEGORIES } from '../../mini-apps/dto/store-query.dto';

export class CreateAppDto {
  @IsString() @MaxLength(100) name!: string;
  @IsString() @MaxLength(100) slug!: string;
  @IsString() @MaxLength(200) shortDescription!: string;
  @IsString() description!: string;
  @IsIn(CATEGORIES) category!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(10) tags?: string[];
  @IsOptional() @IsUrl() privacyPolicyUrl?: string;
  @IsOptional() @IsUrl() termsUrl?: string;
  @IsOptional() @IsUrl() supportUrl?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedDomains?: string[];
  @IsOptional() @IsUrl() iconUrl?: string;
}
