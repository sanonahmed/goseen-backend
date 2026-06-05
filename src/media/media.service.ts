import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as path from 'path';
import { DB_POOL } from '../database/database.module';
import { v4 as uuidv4 } from 'uuid';

export interface UploadResult {
  id: string;
  url: string;
  key: string;
  type: string;
  size_bytes: number;
}

@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {
    this.bucket = config.get('R2_BUCKET_NAME')!;
    this.publicUrl = config.get('R2_PUBLIC_URL')!;

    // Cloudflare R2 uses S3-compatible API
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get('R2_ACCESS_KEY_ID')!,
        secretAccessKey: config.get('R2_SECRET_ACCESS_KEY')!,
      },
    });
  }

  async uploadFile(
    uploaderId: string,
    file: Express.Multer.File,
    type: string,
  ): Promise<UploadResult> {
    const ext = path.extname(file.originalname) || this.mimeToExt(file.mimetype);
    const key = `${type}/${uploaderId}/${uuidv4()}${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.size,
        // No ACL needed — Cloudflare R2 uses bucket-level public access
      }),
    );

    const publicUrl = `${this.publicUrl}/${key}`;

    const { rows } = await this.pool.query(
      `INSERT INTO media_files (uploader_id, type, original_name, mime_type, size_bytes, r2_key, public_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, public_url, r2_key, type, size_bytes`,
      [
        uploaderId,
        type,
        file.originalname,
        file.mimetype,
        file.size,
        key,
        publicUrl,
      ],
    );

    return {
      id: rows[0].id,
      url: rows[0].public_url,
      key: rows[0].r2_key,
      type: rows[0].type,
      size_bytes: rows[0].size_bytes,
    };
  }

  async deleteFile(mediaFileId: string, userId: string): Promise<void> {
    const { rows } = await this.pool.query(
      'SELECT r2_key, uploader_id FROM media_files WHERE id = $1',
      [mediaFileId],
    );
    const file = rows[0];
    if (!file || file.uploader_id !== userId) return;

    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: file.r2_key }),
    );
    await this.pool.query('DELETE FROM media_files WHERE id = $1', [mediaFileId]);
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
    };
    return map[mime] ?? '';
  }
}
