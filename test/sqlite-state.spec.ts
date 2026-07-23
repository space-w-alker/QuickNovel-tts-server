import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config';
import { QuotaExceededError, SqliteStateStore } from '../src/state/sqlite-state.store';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Database = require('better-sqlite3');

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

  it('registers pending installations and supports approval and suspension', () => {
    const installationId = randomUUID();
    expect(store.registerInstallation(installationId).status).toBe('pending');
    expect(store.getInstallationStatus(installationId)).toBe('pending');
    expect(store.setInstallationStatus(installationId, 'approved')).toBe('pending');
    expect(store.getInstallationStatus(installationId)).toBe('approved');
    expect(store.setInstallationStatus(installationId, 'suspended')).toBe('approved');
    expect(store.listInstallations()[0]).toMatchObject({
      id: installationId,
      backendGenerationStatus: 'suspended',
    });
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

  it('sorts the audio library by cache hits and file size', () => {
    const firstInstallation = randomUUID();
    const secondInstallation = randomUUID();
    store.registerInstallation(firstInstallation);
    store.registerInstallation(secondInstallation);
    const first = {
      cacheKey: '1'.repeat(64),
      modelId: 'model',
      modelCacheRevision: 'model@1',
      voiceId: 'voice',
      textHash: 'a'.repeat(64),
      inputCharacters: 1,
    };
    const second = {
      ...first,
      cacheKey: '2'.repeat(64),
      textHash: 'b'.repeat(64),
    };

    store.claimAudio(firstInstallation, first);
    store.markReady(first.cacheKey, 'audio/mpeg', 100);
    store.claimAudio(secondInstallation, second);
    store.markReady(second.cacheKey, 'audio/mpeg', 300);
    store.claimAudio(firstInstallation, first);
    store.claimAudio(firstInstallation, first);

    expect(store.listAudio(50, 0, undefined, 'cacheHits', 'desc').map((record) => record.cacheKey)).toEqual([
      first.cacheKey,
      second.cacheKey,
    ]);
    expect(store.listAudio(50, 0, undefined, 'size', 'asc').map((record) => record.cacheKey)).toEqual([
      first.cacheKey,
      second.cacheKey,
    ]);
    expect(store.listAudio(50, 0, undefined, 'size', 'desc').map((record) => record.cacheKey)).toEqual([
      second.cacheKey,
      first.cacheKey,
    ]);
  });

  it('replaces the legacy database and audio directory exactly once', async () => {
    store.onApplicationShutdown();
    const databasePath = join(directory, 'quicknovel-tts.sqlite');
    await rm(databasePath, { force: true });
    const legacy = new Database(databasePath);
    legacy.exec('CREATE TABLE installations (id TEXT PRIMARY KEY); PRAGMA user_version = 0;');
    legacy.close();
    const audioDirectory = join(directory, 'audio', 'aa');
    await mkdir(audioDirectory, { recursive: true });
    await writeFile(join(audioDirectory, 'legacy.mp3'), 'legacy');

    store = new SqliteStateStore({
      dataDir: directory,
      dailyCharacterQuota: 5,
      dailyGenerationQuota: 1,
    } as AppConfig);
    store.onModuleInit();

    expect(store.listInstallations()).toEqual([]);
    const current = new Database(databasePath, { readonly: true });
    expect(current.pragma('user_version', { simple: true })).toBe(1);
    current.close();
  });
});
