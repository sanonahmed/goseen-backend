import {
  IsArray, IsString, IsOptional, IsUUID, IsIn,
  ValidateNested, ArrayMaxSize, IsObject, IsInt, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const EVENT_TYPES = [
  'app_open', 'app_close', 'api_call',
  'permission_granted', 'permission_denied',
  'payment_initiated', 'payment_success', 'payment_failure',
  'error', 'custom',
] as const;

export class AnalyticsEventDto {
  @IsUUID() miniAppId!: string;
  @IsIn(EVENT_TYPES) eventType!: string;
  @IsOptional() @IsString() eventName?: string;
  @IsOptional() @IsObject() eventData?: Record<string, unknown>;
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsString() goseenVersion?: string;
  @IsOptional() @IsInt() @Min(0) durationMs?: number;
}

export class BatchEventsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventDto)
  events!: AnalyticsEventDto[];
}
