import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config';
import { QuotaExceededError, SqliteStateStore } from '../src/state/sqlite-state.store';

describe('SqliteStateStore', () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quicknovel-state-'));
    store = new SqliteStateStore({
      dataDir: directory,
      dailyCharacterQuota: 5,
      dailyGenerationQuota: 1,
    } as AppConfig);
    store.onModuleInit();
  });

  afterEach(async () => {
    store.onApplicationShutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it('claims a cache key once and charges quota once', () => {
    const installationId = randomUUID();
    store.registerInstallation(installationId);
    const input = {
      cacheKey: 'a'.repeat(64),
      modelId: 'model',
      modelCacheRevision: 'model@1',
      voiceId: 'voice',
      textHash: 'b'.repeat(64),
      inputCharacters: 5,
    };
    const first = store.claimAudio(installationId, input);
    const second = store.claimAudio(installationId, input);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.record.jobId).toBe(first.record.jobId);
    expect(store.getQuota(installationId).charactersRemaining).toBe(0);
    expect(store.getQuota(installationId).requestsRemaining).toBe(0);
  });

  it('rejects a new generation after quota is exhausted', () => {
    const installationId = randomUUID();
    store.registerInstallation(installationId);
    store.claimAudio(installationId, {
      cacheKey: 'a'.repeat(64),
      modelId: 'model',
      modelCacheRevision: 'model@1',
      voiceId: 'voice',
      textHash: 'b'.repeat(64),
      inputCharacters: 5,
    });
    expect(() =>
      store.claimAudio(installationId, {
        cacheKey: 'c'.repeat(64),
        modelId: 'model',
        modelCacheRevision: 'model@1',
        voiceId: 'voice',
        textHash: 'd'.repeat(64),
        inputCharacters: 1,
      }),
    ).toThrow(QuotaExceededError);
  });

  it('preserves installations, quota, and ready cache metadata across restarts', () => {
    const installationId = randomUUID();
    store.registerInstallation(installationId);
    store.claimAudio(installationId, {
      cacheKey: 'e'.repeat(64),
      modelId: 'model',
      modelCacheRevision: 'model@1',
      voiceId: 'voice',
      textHash: 'f'.repeat(64),
      inputCharacters: 4,
    });
    store.markReady('e'.repeat(64), 'audio/mpeg', 123);
    store.onApplicationShutdown();

    store = new SqliteStateStore({
      dataDir: directory,
      dailyCharacterQuota: 5,
      dailyGenerationQuota: 1,
    } as AppConfig);
    store.onModuleInit();

    expect(store.hasInstallation(installationId)).toBe(true);
    expect(store.getQuota(installationId).charactersRemaining).toBe(1);
    expect(store.getAudio('e'.repeat(64))?.status).toBe('ready');
    expect(store.getAudio('e'.repeat(64))?.bytes).toBe(123);
  });
});
