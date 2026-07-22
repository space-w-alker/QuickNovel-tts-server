import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../src/config/app-config';
import { AudioStorageService } from '../src/tts/audio-storage.service';

describe('AudioStorageService', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quicknovel-audio-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('signs URLs that expire and reject tampering', () => {
    const service = new AudioStorageService({
      dataDir: directory,
      publicBaseUrl: 'https://quicknovel-140-238-89-232.sslip.io',
      audioUrlTtlSeconds: 60,
      audioSigningSecret: 's'.repeat(32),
    } as AppConfig);
    const cacheKey = 'a'.repeat(64);
    const now = new Date('2026-01-01T00:00:00Z');
    const signed = new URL(service.signedUrl(cacheKey, now).url);
    const expires = signed.searchParams.get('expires') ?? undefined;
    const signature = signed.searchParams.get('signature') ?? undefined;
    expect(signed.origin).toBe('https://quicknovel-140-238-89-232.sslip.io');
    expect(service.verify(cacheKey, expires, signature, new Date('2026-01-01T00:00:59Z'))).toBe(true);
    expect(service.verify(cacheKey, expires, signature, new Date('2026-01-01T00:01:00Z'))).toBe(false);
    expect(service.verify('b'.repeat(64), expires, signature, now)).toBe(false);
  });

  it('removes a cached audio file without failing when it is already absent', async () => {
    const service = new AudioStorageService({
      dataDir: directory,
      publicBaseUrl: 'https://quicknovel-140-238-89-232.sslip.io',
      audioUrlTtlSeconds: 60,
      audioSigningSecret: 's'.repeat(32),
    } as AppConfig);
    const cacheKey = 'c'.repeat(64);
    await service.save(cacheKey, Buffer.from('audio'));

    expect(await service.remove(cacheKey)).toBe(true);
    await expect(stat(join(directory, 'audio', 'cc', `${cacheKey}.mp3`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.remove(cacheKey)).toBe(false);
  });
});
