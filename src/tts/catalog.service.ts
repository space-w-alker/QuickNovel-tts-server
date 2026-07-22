import { Injectable } from '@nestjs/common';
import { AppConfig, ProviderAudioFormat, VoiceConfig } from '../config/app-config';

export interface ResolvedCatalogSelection {
  publicModelId: string;
  openRouterModel: string;
  cacheRevision: string;
  voice: VoiceConfig;
  providerAudioFormat: ProviderAudioFormat;
}

@Injectable()
export class CatalogService {
  constructor(private readonly config: AppConfig) {}

  catalog(): Record<string, unknown> {
    return {
      catalog_version: this.config.models.map((model) => `${model.id}:${model.cacheRevision}`).join('|'),
      models: this.config.models.map((model) => ({
        id: model.id,
        display_name: model.displayName,
        cache_revision: model.cacheRevision,
        output_format: 'mp3',
        voices: model.voices.map((voice) => ({
          id: voice.id,
          display_name: voice.displayName,
          locale: voice.locale,
        })),
      })),
    };
  }

  resolve(modelId: string, voiceId: string): ResolvedCatalogSelection | undefined {
    const model = this.config.models.find((candidate) => candidate.id === modelId);
    if (!model) return undefined;
    const voice = model.voices.find((candidate) => candidate.id === voiceId);
    if (!voice) return undefined;
    return {
      publicModelId: model.id,
      openRouterModel: model.openRouterModel,
      cacheRevision: model.cacheRevision,
      voice,
      providerAudioFormat: model.providerAudioFormat,
    };
  }
}
