import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';

export interface VoiceConfig {
  id: string;
  displayName: string;
  locale: string;
}

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function secret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
}

@Injectable()
export class AppConfig {
  readonly port = integer('PORT', 3000);
  readonly host = process.env.HOST ?? '0.0.0.0';
  readonly publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${this.port}`).replace(/\/$/, '');
  readonly dataDir = resolve(process.env.DATA_DIR ?? './data');
  readonly accessTokenSecret = secret('ACCESS_TOKEN_SECRET');
  readonly audioSigningSecret = secret('AUDIO_SIGNING_SECRET');
  readonly accessTokenTtlSeconds = integer('ACCESS_TOKEN_TTL_SECONDS', 3600);
  readonly audioUrlTtlSeconds = integer('AUDIO_URL_TTL_SECONDS', 900);
  readonly rateLimitMax = integer('RATE_LIMIT_MAX', 300);
  readonly rateLimitWindow = process.env.RATE_LIMIT_WINDOW ?? '1 minute';
  readonly openRouterApiKey = process.env.OPENROUTER_API_KEY ?? '';
  readonly openRouterBaseUrl = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  readonly openRouterHttpReferer = process.env.OPENROUTER_HTTP_REFERER;
  readonly openRouterAppTitle = process.env.OPENROUTER_APP_TITLE ?? 'QuickNovel';
  readonly maxChunkCharacters = integer('MAX_CHUNK_CHARACTERS', 4000);
  readonly maxAudioBytes = integer('MAX_AUDIO_BYTES', 50 * 1024 * 1024);
  readonly dailyCharacterQuota = integer('DAILY_CHARACTER_QUOTA', 100_000);
  readonly dailyGenerationQuota = integer('DAILY_GENERATION_QUOTA', 1_000);
  readonly model = {
    id: process.env.TTS_MODEL_ID ?? 'quicknovel-default',
    displayName: process.env.TTS_MODEL_DISPLAY_NAME ?? 'QuickNovel Voice',
    openRouterModel: process.env.TTS_OPENROUTER_MODEL ?? 'openai/gpt-4o-mini-tts',
    cacheRevision: process.env.TTS_MODEL_CACHE_REVISION ?? 'openai/gpt-4o-mini-tts@1',
    voices: this.parseVoices(process.env.TTS_VOICES ?? 'alloy:Alloy:en-US'),
  };

  private parseVoices(value: string): VoiceConfig[] {
    const voices = value.split(',').map((entry) => {
      const [id, displayName, locale] = entry.split(':').map((part) => part.trim());
      if (!id || !displayName || !locale) {
        throw new Error(`Invalid TTS_VOICES entry: ${entry}`);
      }
      return { id, displayName, locale };
    });
    if (new Set(voices.map((voice) => voice.id)).size !== voices.length) {
      throw new Error('TTS_VOICES contains duplicate voice IDs');
    }
    return voices;
  }
}
