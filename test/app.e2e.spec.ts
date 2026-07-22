import 'reflect-metadata';
import cookie from '@fastify/cookie';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/api-error';
import { CatalogService } from '../src/tts/catalog.service';
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
      SUPER_ADMIN_USERNAME: 'superadmin',
      SUPER_ADMIN_PASSWORD: 'test-admin-password-12345',
      ADMIN_SECURE_COOKIE: 'false',
      DAILY_CHARACTER_QUOTA: '100000',
      DAILY_GENERATION_QUOTA: '1000',
    });
    generator = new FakeSpeechGenerator();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SpeechGenerator)
      .useValue(generator)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
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
    expect(catalog.json().models).toHaveLength(3);
    expect(catalog.json().models.map((model: { id: string }) => model.id)).toEqual(['standard', 'high', 'ultra']);
    expect(catalog.json().models[0].voices).toHaveLength(2);
    expect(app.get(CatalogService).resolve('high', 'female')).toMatchObject({
      openRouterModel: 'x-ai/grok-voice-tts-1.0',
      providerAudioFormat: 'mp3',
      voice: { providerVoice: 'ara' },
    });
    expect(app.get(CatalogService).resolve('ultra', 'male')).toMatchObject({
      openRouterModel: 'google/gemini-3.1-flash-tts-preview',
      providerAudioFormat: 'pcm',
      voice: { providerVoice: 'Puck' },
    });
  });

  it('generates once, polls the job, serves signed audio, and reuses the cache', async () => {
    const payload = {
      model_id: 'standard',
      voice_id: 'male',
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
    const calls = generator.calls.filter((call) => call.text === payload.text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'hexgrad/kokoro-82m',
      voice: 'am_echo',
      responseFormat: 'mp3',
    });

    const normalizedEquivalent = await resolve({ ...payload, text: '  A REUSABLE\n sentence.  ' });
    expect(normalizedEquivalent.statusCode).toBe(200);
    expect(normalizedEquivalent.json().cache_key).toBe(firstBody.cache_key);
    expect(normalizedEquivalent.json().cache_hit).toBe(true);
    expect(generator.calls).toHaveLength(1);
  });

  it('deduplicates concurrent generation requests', async () => {
    const payload = {
      model_id: 'standard',
      voice_id: 'female',
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
      voice_id: 'male',
      text: 'Hello.',
      chunker_version: 1,
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error.code).toBe('catalog_entry_unavailable');

    const malformed = await resolve({ model_id: 'standard' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('validation_failed');
  });

  it('authenticates the admin console and applies audited runtime controls', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/overview' });
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe('/admin/login');

    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: 'username=superadmin&password=wrong-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(invalid.headers.location).toBe('/admin/login?error=invalid');

    const login = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: 'username=superadmin&password=test-admin-password-12345',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(login.statusCode).toBe(302);
    const sessionCookie = login.headers['set-cookie']?.split(';')[0];
    expect(sessionCookie).toContain('quicknovel_admin_session=');

    const settingsPage = await app.inject({
      method: 'GET',
      url: '/admin/settings',
      headers: { cookie: sessionCookie },
    });
    expect(settingsPage.statusCode).toBe(200);
    expect(settingsPage.body).toContain('Runtime controls');
    const csrfToken = settingsPage.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(csrfToken).toBeTruthy();

    const pause = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        csrf_token: csrfToken ?? '',
        daily_character_quota: '100000',
        daily_generation_quota: '1000',
        max_chunk_characters: '4000',
        log_retention_days: '30',
      }).toString(),
    });
    expect(pause.statusCode).toBe(302);

    const pausedGeneration = await resolve({
      model_id: 'standard',
      voice_id: 'male',
      text: 'This uncached request should be paused.',
      chunker_version: 1,
    });
    expect(pausedGeneration.statusCode).toBe(503);
    expect(pausedGeneration.json().error.code).toBe('generation_paused');

    const resume = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        csrf_token: csrfToken ?? '',
        generation_enabled: 'on',
        daily_character_quota: '100000',
        daily_generation_quota: '1000',
        max_chunk_characters: '4000',
        log_retention_days: '30',
      }).toString(),
    });
    expect(resume.statusCode).toBe(302);

    const events = await app.inject({ method: 'GET', url: '/admin/events', headers: { cookie: sessionCookie } });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('settings_updated');

    const generationRequests = await app.inject({
      method: 'GET',
      url: '/admin/generation-requests',
      headers: { cookie: sessionCookie },
    });
    expect(generationRequests.statusCode).toBe(200);
    expect(generationRequests.body).toContain('Cache hit');
    expect(generationRequests.body).toContain('Cache miss');

    const audioLibrary = await app.inject({
      method: 'GET',
      url: '/admin/audio',
      headers: { cookie: sessionCookie },
    });
    expect(audioLibrary.statusCode).toBe(200);
    expect(audioLibrary.body).toContain('Audio library');
    expect(audioLibrary.body).toContain('Total audio size');
    expect(audioLibrary.body).toContain('Audio records');
    expect(audioLibrary.body).toContain('Cache outcomes');
    expect(audioLibrary.body).toContain('<audio class="player" controls');
    expect(audioLibrary.body).toContain('Download');
    const deleteCacheKey = audioLibrary.body.match(/\/admin\/audio\/([a-f0-9]{64})\/delete/)?.[1];
    expect(deleteCacheKey).toBeTruthy();

    const deleted = await app.inject({
      method: 'POST',
      url: `/admin/audio/${deleteCacheKey}/delete`,
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf_token: csrfToken ?? '' }).toString(),
    });
    expect(deleted.statusCode).toBe(302);
    expect(deleted.headers.location).toBe('/admin/audio?notice=audio-deleted');

    const preservedHistory = await app.inject({
      method: 'GET',
      url: '/admin/generation-requests',
      headers: { cookie: sessionCookie },
    });
    expect(preservedHistory.body).toContain(deleteCacheKey);
    expect(preservedHistory.body).toContain('deleted');
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
