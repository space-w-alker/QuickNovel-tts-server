import 'dotenv/config';
import 'reflect-metadata';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-error';
import { AppConfig } from './config/app-config';
import { SqliteStateStore } from './state/sqlite-state.store';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.register(cors, { origin: false });
  await app.register(cookie);
  const config = app.get(AppConfig);
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: config.rateLimitWindow });
  const state = app.get(SqliteStateStore);
  const startedAt = new Map<string, number>();
  const server = app.getHttpAdapter().getInstance();
  server.addHook('onRequest', (request, _reply, done) => {
    startedAt.set(request.id, performance.now());
    done();
  });
  server.addHook('onResponse', (request, reply, done) => {
    const start = startedAt.get(request.id) ?? performance.now();
    startedAt.delete(request.id);
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/admin') && path !== '/health') {
      const installationId = (request as typeof request & { installationId?: string }).installationId;
      try {
        state.recordHttpRequest({
          requestId: request.id,
          method: request.method,
          path,
          statusCode: reply.statusCode,
          durationMs: Math.max(0, Math.round(performance.now() - start)),
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          installationId,
          createdAt: new Date().toISOString(),
        });
        if (reply.statusCode >= 500) {
          state.recordEvent({
            severity: 'error',
            category: 'http',
            action: 'server_error_response',
            message: `${request.method} ${path} returned ${reply.statusCode}.`,
            context: JSON.stringify({ requestId: request.id, installationId }),
          });
        }
      } catch (error) {
        console.error('Failed to persist request observability data', error);
      }
    }
    done();
  });
  server.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/admin')) {
      void reply
        .header('cache-control', 'no-store')
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'same-origin')
        .header(
          'content-security-policy',
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
        );
    }
    done(null, payload);
  });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap();
