import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  // Debug: log every request's auth header so we can verify JWT delivery
  app.use((req: any, _res: any, next: any) => {
    const auth = req.headers.authorization;
    const token = auth?.split(' ')[1];
    console.log(`[REQ] ${req.method} ${req.path} - auth: ${token ? `present (${token.length} chars)` : 'MISSING'}`);
    next();
  });

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

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`GoSeen API running on :${port}`);
}

bootstrap();
