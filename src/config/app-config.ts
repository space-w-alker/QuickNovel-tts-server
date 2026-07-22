import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';

export interface VoiceConfig {
  id: string;
  displayName: string;
  locale: string;
  providerVoice: string;
}

export type ProviderAudioFormat = 'mp3' | 'pcm';

export interface TtsModelConfig {
  id: string;
  displayName: string;
  openRouterModel: string;
  cacheRevision: string;
  providerAudioFormat: ProviderAudioFormat;
  voices: VoiceConfig[];
}

const DEFAULT_TTS_MODELS: TtsModelConfig[] = [
  {
    id: 'standard',
    displayName: 'Standard',
    openRouterModel: 'hexgrad/kokoro-82m',
    cacheRevision: 'standard@1',
    providerAudioFormat: 'mp3',
    voices: [
      { id: 'male', displayName: 'Male', locale: 'en-US', providerVoice: 'am_echo' },
      { id: 'female', displayName: 'Female', locale: 'en-US', providerVoice: 'af_heart' },
    ],
  },
  {
    id: 'high',
    displayName: 'High',
    openRouterModel: 'x-ai/grok-voice-tts-1.0',
    cacheRevision: 'high@1',
    providerAudioFormat: 'mp3',
    voices: [
      { id: 'male', displayName: 'Male', locale: 'en-US', providerVoice: 'rex' },
      { id: 'female', displayName: 'Female', locale: 'en-US', providerVoice: 'ara' },
    ],
  },
  {
    id: 'ultra',
    displayName: 'Ultra',
    openRouterModel: 'google/gemini-3.1-flash-tts-preview',
    cacheRevision: 'ultra@1',
    providerAudioFormat: 'pcm',
    voices: [
      { id: 'male', displayName: 'Male', locale: 'en-US', providerVoice: 'Puck' },
      { id: 'female', displayName: 'Female', locale: 'en-US', providerVoice: 'Zephyr' },
    ],
  },
];

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

function required(name: string, minimumLength: number): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters`);
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
  readonly superAdminUsername = process.env.SUPER_ADMIN_USERNAME ?? 'superadmin';
  readonly superAdminPassword = required('SUPER_ADMIN_PASSWORD', 12);
  readonly adminSessionTtlSeconds = integer('ADMIN_SESSION_TTL_SECONDS', 12 * 60 * 60);
  readonly secureAdminCookie = process.env.ADMIN_SECURE_COOKIE
    ? process.env.ADMIN_SECURE_COOKIE === 'true'
    : this.publicBaseUrl.startsWith('https://');
  readonly openRouterApiKey = process.env.OPENROUTER_API_KEY ?? '';
  readonly openRouterBaseUrl = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  readonly openRouterHttpReferer = process.env.OPENROUTER_HTTP_REFERER;
  readonly openRouterAppTitle = process.env.OPENROUTER_APP_TITLE ?? 'QuickNovel';
  readonly maxChunkCharacters = integer('MAX_CHUNK_CHARACTERS', 4000);
  readonly maxAudioBytes = integer('MAX_AUDIO_BYTES', 50 * 1024 * 1024);
  readonly dailyCharacterQuota = integer('DAILY_CHARACTER_QUOTA', 100_000);
  readonly dailyGenerationQuota = integer('DAILY_GENERATION_QUOTA', 1_000);
  readonly models = this.parseModels(process.env.TTS_MODELS_JSON);

  private parseModels(value: string | undefined): TtsModelConfig[] {
    const models: unknown = value ? JSON.parse(value) : DEFAULT_TTS_MODELS;
    if (!Array.isArray(models) || models.length === 0) throw new Error('TTS_MODELS_JSON must contain at least one model');
    const parsed = models.map((candidate, index) => this.parseModel(candidate, index));
    if (new Set(parsed.map((model) => model.id)).size !== parsed.length) {
      throw new Error('TTS_MODELS_JSON contains duplicate model IDs');
    }
    return parsed;
  }

  private parseModel(candidate: unknown, index: number): TtsModelConfig {
    if (!candidate || typeof candidate !== 'object') throw new Error(`Invalid TTS model at index ${index}`);
    const model = candidate as Partial<TtsModelConfig>;
    const required = [model.id, model.displayName, model.openRouterModel, model.cacheRevision];
    if (required.some((field) => typeof field !== 'string' || field.trim().length === 0)) {
      throw new Error(`Invalid TTS model at index ${index}`);
    }
    if (model.providerAudioFormat !== 'mp3' && model.providerAudioFormat !== 'pcm') {
      throw new Error(`Invalid provider audio format for TTS model ${model.id}`);
    }
    if (!Array.isArray(model.voices) || model.voices.length === 0) {
      throw new Error(`TTS model ${model.id} must contain at least one voice`);
    }
    const voices = model.voices.map((voice, voiceIndex) => {
      if (!voice || typeof voice !== 'object') throw new Error(`Invalid voice ${voiceIndex} for TTS model ${model.id}`);
      const requiredVoice = [voice.id, voice.displayName, voice.locale, voice.providerVoice];
      if (requiredVoice.some((field) => typeof field !== 'string' || field.trim().length === 0)) {
        throw new Error(`Invalid voice ${voiceIndex} for TTS model ${model.id}`);
      }
      return voice;
    });
    if (new Set(voices.map((voice) => voice.id)).size !== voices.length) {
      throw new Error(`TTS model ${model.id} contains duplicate voice IDs`);
    }
    return { ...model, voices } as TtsModelConfig;
  }
}
