import { IsString, MaxLength, IsOptional, IsUrl } from 'class-validator';

export class RegisterDeveloperDto {
  @IsString() @MaxLength(100) displayName!: string;
  @IsOptional() @IsUrl() websiteUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
