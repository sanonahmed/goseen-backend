import { IsArray, IsString } from 'class-validator';

export const VALID_SCOPES = [
  'profile', 'profile_email', 'camera', 'microphone',
  'location', 'notifications', 'files_read', 'files_write',
  'contacts', 'send_message', 'payments',
] as const;

export class UpdatePermissionsDto {
  @IsArray() @IsString({ each: true }) granted!: string[];
  @IsArray() @IsString({ each: true }) denied!: string[];
}
