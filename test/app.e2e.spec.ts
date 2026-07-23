import 'reflect-metadata';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
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
import { SqliteStateStore } from '../src/state/sqlite-state.store';
import { AudioTranscoder } from '../src/tts/audio-transcoder';
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
      OPENROUTER_API_KEY: 'test-openrouter-key',
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
    await app.register(multipart);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const installationId = randomUUID();
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/installations',
      payload: { installation_id: installationId, app_version: '1.0.0', platform: 'android' },
    });
    expect(registration.statusCode).toBe(201);
    app.get(SqliteStateStore).setInstallationStatus(installationId, 'approved');
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
      provider: 'speechify',
      model: 'simba-3.2',
      providerAudioFormat: 'mp3',
      maxInputCharacters: 2000,
      voice: { providerVoice: 'beatrice_32' },
    });
    expect(app.get(CatalogService).resolve('ultra', 'male')).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-tts-preview',
      providerAudioFormat: 'pcm',
      voice: { providerVoice: 'Puck' },
    });
  });

  it('generates once, polls the job, serves signed audio, and reuses the cache', async () => {
    const payload = {
      model_id: 'standard',
      voice_id: 'male',
      text: 'A reusable sentence.',
      chunker_version: 2,
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
      provider: 'openrouter',
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
      chunker_version: 2,
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
      chunker_version: 2,
    });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error.code).toBe('catalog_entry_unavailable');

    const malformed = await resolve({ model_id: 'standard' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('validation_failed');
  });

  it('keeps pending installations on cache and BYOK while blocking backend misses', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/installations',
      payload: { installation_id: randomUUID(), app_version: '1.0.0', platform: 'android' },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().backend_generation_status).toBe('pending');
    const pendingToken = registration.json().access_token as string;
    const pendingResolve = (payload: Record<string, unknown>) => app.inject({
      method: 'POST',
      url: '/v1/tts/chunks:resolve',
      headers: { authorization: `Bearer ${pendingToken}` },
      payload,
    });
    const cached = await pendingResolve({
      quality: 'standard', gender: 'male', text: 'A reusable sentence.', chunker_version: 2,
    });
    expect(cached.statusCode).toBe(200);
    const blocked = await pendingResolve({
      quality: 'standard', gender: 'male', text: 'Pending backend miss.', chunker_version: 2,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('backend_generation_approval_required');
    const byok = await pendingResolve({
      provider: 'speechify',
      model: 'simba-3.0',
      voice: 'george',
      generation_source: 'byok',
      text: 'Pending BYOK miss.',
      chunker_version: 2,
    });
    expect(byok.statusCode).toBe(200);
    expect(byok.json()).toMatchObject({
      state: 'upload_required',
      selection: { provider: 'speechify', model: 'simba-3.0', voice: 'george' },
    });
  });

  it('accepts a pending Speechify BYOK upload and shares it with other installations', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/v1/installations',
      payload: { installation_id: randomUUID(), app_version: '1.0.0', platform: 'android' },
    });
    const pendingToken = registration.json().access_token as string;
    const metadata = {
      provider: 'speechify',
      model: 'simba-3.0',
      voice: 'george',
      generation_source: 'byok',
      text: 'Shared Speechify upload.',
      chunker_version: 2,
    };
    const mp3 = await app.get(AudioTranscoder).pcmToMp3(Buffer.alloc(24_000), 1024 * 1024);
    const boundary = 'quicknovel-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n`
        + `${JSON.stringify(metadata)}\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="speech.mp3"\r\n`
        + 'Content-Type: audio/mpeg\r\n\r\n',
      ),
      mp3,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/tts/chunks/upload',
      headers: {
        authorization: `Bearer ${pendingToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ state: 'ready', cache_hit: false });

    const shared = await resolve(metadata);
    expect(shared.statusCode).toBe(200);
    expect(shared.json().cache_key).toBe(uploaded.json().cache_key);
    expect(shared.json().cache_hit).toBe(true);
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

    const pendingInstallation = app.get(SqliteStateStore)
      .listInstallations()
      .find((installation) => installation.backendGenerationStatus === 'pending');
    expect(pendingInstallation).toBeTruthy();
    const approve = await app.inject({
      method: 'POST',
      url: `/admin/installations/${pendingInstallation?.id}/approve`,
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf_token: csrfToken ?? '' }).toString(),
    });
    expect(approve.statusCode).toBe(302);
    expect(app.get(SqliteStateStore).getInstallationStatus(pendingInstallation?.id ?? '')).toBe('approved');
    const suspend = await app.inject({
      method: 'POST',
      url: `/admin/installations/${pendingInstallation?.id}/suspend`,
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf_token: csrfToken ?? '' }).toString(),
    });
    expect(suspend.statusCode).toBe(302);
    expect(app.get(SqliteStateStore).getInstallationStatus(pendingInstallation?.id ?? '')).toBe('suspended');

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
      chunker_version: 2,
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
    expect(audioLibrary.body).toContain('Requests / cache hits');
    expect(audioLibrary.body).toContain('sort&#x3D;cacheHits&amp;direction&#x3D;desc');
    expect(audioLibrary.body).toContain('sort&#x3D;size&amp;direction&#x3D;desc');
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
