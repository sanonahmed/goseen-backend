import { IsString, MinLength } from 'class-validator';

export class VerifyInitDataDto {
  @IsString() @MinLength(10) initData!: string;
}
