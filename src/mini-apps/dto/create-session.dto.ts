import { IsString, IsOptional, IsUUID } from 'class-validator';

export class CreateSessionDto {
  @IsUUID() miniAppId!: string;
  @IsOptional() @IsString() startParam?: string;
}
