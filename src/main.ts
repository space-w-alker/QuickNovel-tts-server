import 'dotenv/config';
import 'reflect-metadata';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-error';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.register(cors, { origin: false });
  const config = app.get(AppConfig);
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: config.rateLimitWindow });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap();
