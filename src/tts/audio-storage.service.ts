import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppConfig } from '../config/app-config';

@Injectable()
export class AudioStorageService {
  constructor(private readonly config: AppConfig) {}

  async save(cacheKey: string, audio: Buffer): Promise<number> {
    const path = this.path(cacheKey);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, audio, { mode: 0o600 });
    await rename(temporaryPath, path);
    return (await stat(path)).size;
  }

  stream(cacheKey: string): NodeJS.ReadableStream {
    return createReadStream(this.path(cacheKey));
  }

  signedUrl(cacheKey: string, now = new Date()): { url: string; expiresAt: string } {
    const expires = Math.floor(now.getTime() / 1000) + this.config.audioUrlTtlSeconds;
    const signature = this.signature(cacheKey, expires);
    return {
      url: `${this.config.publicBaseUrl}/v1/tts/audio/${cacheKey}?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  verify(cacheKey: string, expiresValue: string | undefined, signature: string | undefined, now = new Date()): boolean {
    const expires = Number.parseInt(expiresValue ?? '', 10);
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(now.getTime() / 1000) || !signature) return false;
    const expected = this.signature(cacheKey, expires);
    return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  private path(cacheKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new Error('Invalid audio cache key');
    return join(this.config.dataDir, 'audio', cacheKey.slice(0, 2), `${cacheKey}.mp3`);
  }

  private signature(cacheKey: string, expires: number): string {
    return createHmac('sha256', this.config.audioSigningSecret)
      .update(`${cacheKey}\n${expires}`)
      .digest('base64url');
  }
}
