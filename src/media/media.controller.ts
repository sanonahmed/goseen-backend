import {
  Controller,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';

const ALLOWED_TYPES = new Set([
  'avatar', 'image', 'video', 'voice', 'file',
]);

const MAX_SIZES: Record<string, number> = {
  avatar: 5 * 1024 * 1024,   // 5 MB
  image:  20 * 1024 * 1024,  // 20 MB
  video:  200 * 1024 * 1024, // 200 MB
  voice:  10 * 1024 * 1024,  // 10 MB
  file:   100 * 1024 * 1024, // 100 MB
};

@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('type') type: string = 'file',
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    if (!ALLOWED_TYPES.has(type)) {
      throw new BadRequestException(`Invalid type. Allowed: ${[...ALLOWED_TYPES].join(', ')}`);
    }
    const maxSize = MAX_SIZES[type] ?? MAX_SIZES.file;
    if (file.size > maxSize) {
      throw new BadRequestException(
        `File too large for type "${type}". Max: ${maxSize / 1024 / 1024} MB`,
      );
    }
    return this.media.uploadFile(req.user.id, file, type);
  }

  @Delete(':id')
  deleteFile(@Param('id') id: string, @Request() req: any) {
    return this.media.deleteFile(id, req.user.id);
  }
}
