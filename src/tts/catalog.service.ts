import { Injectable } from '@nestjs/common';
import { AppConfig, VoiceConfig } from '../config/app-config';

export interface ResolvedCatalogSelection {
  publicModelId: string;
  openRouterModel: string;
  cacheRevision: string;
  voice: VoiceConfig;
}

@Injectable()
export class CatalogService {
  constructor(private readonly config: AppConfig) {}

  catalog(): Record<string, unknown> {
    return {
      catalog_version: this.config.model.cacheRevision,
      models: [
        {
          id: this.config.model.id,
          display_name: this.config.model.displayName,
          cache_revision: this.config.model.cacheRevision,
          output_format: 'mp3',
          voices: this.config.model.voices.map((voice) => ({
            id: voice.id,
            display_name: voice.displayName,
            locale: voice.locale,
          })),
        },
      ],
    };
  }

  resolve(modelId: string, voiceId: string): ResolvedCatalogSelection | undefined {
    if (modelId !== this.config.model.id) return undefined;
    const voice = this.config.model.voices.find((candidate) => candidate.id === voiceId);
    if (!voice) return undefined;
    return {
      publicModelId: this.config.model.id,
      openRouterModel: this.config.model.openRouterModel,
      cacheRevision: this.config.model.cacheRevision,
      voice,
    };
  }
}
