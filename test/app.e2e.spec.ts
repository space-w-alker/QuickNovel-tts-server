import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/api-error';
import { SpeechGenerationRequest, SpeechGenerationResult, SpeechGenerator } from '../src/tts/speech-generator';

class FakeSpeechGenerator extends SpeechGenerator {
  readonly calls: SpeechGenerationRequest[] = [];

  async generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    this.calls.push(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { audio: Buffer.from('fake-mp3-audio'), contentType: 'audio/mpeg' };
  }
}

describe('QuickNovel TTS API', () => {
  let app: NestFastifyApplication;
  let directory: string;
  let generator: FakeSpeechGenerator;
  let token: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quicknovel-e2e-'));
    Object.assign(process.env, {
      DATA_DIR: directory,
      PUBLIC_BASE_URL: 'http://localhost:3000',
      ACCESS_TOKEN_SECRET: 'access-token-test-secret-value-123456789',
      AUDIO_SIGNING_SECRET: 'audio-signing-test-secret-value-1234567',
      TTS_MODEL_ID: 'quicknovel-default',
      TTS_MODEL_CACHE_REVISION: 'test-model@1',
      TTS_OPENROUTER_MODEL: 'provider/test-model',
      TTS_VOICES: 'alloy:Alloy:en-US,nova:Nova:en-US',
      DAILY_CHARACTER_QUOTA: '100000',
      DAILY_GENERATION_QUOTA: '1000',
    });
    generator = new FakeSpeechGenerator();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SpeechGenerator)
      .useValue(generator)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const registration = await app.inject({
      method: 'POST',
      url: '/v1/installations',
      payload: { installation_id: randomUUID(), app_version: '1.0.0', platform: 'android' },
    });
    expect(registration.statusCode).toBe(201);
    token = registration.json().access_token as string;
  });

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('exposes health and protects the catalog', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/tts/catalog' })).statusCode).toBe(401);
    const catalog = await app.inject({
      method: 'GET',
      url: '/v1/tts/catalog',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().models[0].voices).toHaveLength(2);
  });

  it('generates once, polls the job, serves signed audio, and reuses the cache', async () => {
    const payload = {
      model_id: 'quicknovel-default',
      voice_id: 'alloy',
      text: 'A reusable sentence.',
      chunker_version: 1,
    };
    const first = await resolve(payload);
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    let completed = await poll(firstBody.job_id as string);
    for (let attempt = 0; completed.statusCode === 202 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await poll(firstBody.job_id as string);
    }
    expect(completed.statusCode).toBe(200);
    const completedBody = completed.json();
    expect(completedBody.cache_hit).toBe(true);

    const audioUrl = new URL(completedBody.audio.url as string);
    const audio = await app.inject({ method: 'GET', url: `${audioUrl.pathname}${audioUrl.search}` });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/mpeg');
    expect(audio.rawPayload).toEqual(Buffer.from('fake-mp3-audio'));

    const cached = await resolve(payload);
    expect(cached.statusCode).toBe(200);
    expect(cached.json().cache_key).toBe(firstBody.cache_key);
    expect(cached.json().cache_hit).toBe(true);
    expect(generator.calls.filter((call) => call.text === payload.text)).toHaveLength(1);
  });

  it('deduplicates concurrent generation requests', async () => {
    const payload = {
      model_id: 'quicknovel-default',
      voice_id: 'nova',
      text: 'A concurrent sentence.',
      chunker_version: 1,
    };
    const [first, second] = await Promise.all([resolve(payload), resolve(payload)]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().job_id).toBe(second.json().job_id);
    expect(generator.calls.filter((call) => call.text === payload.text)).toHaveLength(1);
    let completed = await poll(first.json().job_id as string);
    for (let attempt = 0; completed.statusCode === 202 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await poll(first.json().job_id as string);
    }
    expect(completed.statusCode).toBe(200);
  });

  it('validates catalog combinations and chunk sizes', async () => {
    const unavailable = await resolve({
      model_id: 'unknown',
      voice_id: 'alloy',
      text: 'Hello.',
      chunker_version: 1,
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error.code).toBe('catalog_entry_unavailable');

    const malformed = await resolve({ model_id: 'quicknovel-default' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('validation_failed');
  });

  async function resolve(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/tts/chunks:resolve',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function poll(jobId: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/tts/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }
});
