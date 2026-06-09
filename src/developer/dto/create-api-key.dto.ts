import { IsString, MaxLength, IsOptional, IsArray, IsIn, IsDateString } from 'class-validator';

export const API_KEY_SCOPES = ['read', 'write', 'analytics', 'verify'] as const;

export class CreateApiKeyDto {
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsArray() @IsIn(API_KEY_SCOPES, { each: true }) scopes?: string[];
  @IsOptional() @IsDateString() expiresAt?: string;
}
