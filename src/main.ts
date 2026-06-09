import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { INITIAL_SCHEMA, MIGRATIONS } from './database/schema';

async function applyMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    await pool.query(INITIAL_SCHEMA);
    for (const sql of MIGRATIONS) {
      await pool.query(sql);
    }
    console.log('[migration] Schema up to date');
  } catch (err) {
    console.error('[migration] Failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

async function bootstrap() {
  await applyMigrations();

  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  // Debug: log every request's auth header so we can verify JWT delivery
  app.use((req: any, _res: any, next: any) => {
    const auth = req.headers.authorization;
    const token = auth?.split(' ')[1];
    console.log(`[REQ] ${req.method} ${req.path} - auth: ${token ? `present (${token.length} chars)` : 'MISSING'}`);
    next();
  });

  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? '*',
    credentials: true,
  });

  // Without this, NestJS defaults to the plain `ws` adapter when both ws and
  // socket.io are installed. The Flutter socket_io_client speaks the Socket.IO
  // EIO4 protocol and cannot communicate with a ws server — every connection
  // attempt times out.
  app.useWebSocketAdapter(new IoAdapter(app));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`GoSeen API running on :${port}`);
}

bootstrap();
