import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgoraService } from './agora.service';

class TokenRequestDto {
  @IsString()
  channelName!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  uid?: number;
}

@Controller('agora')
@UseGuards(JwtAuthGuard)
export class AgoraController {
  constructor(private readonly agora: AgoraService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  generateToken(@Body() dto: TokenRequestDto) {
    return this.agora.generateToken(dto.channelName, dto.uid ?? 0);
  }
}
