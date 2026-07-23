import { Injectable } from '@nestjs/common';
import { AppConfig, ProviderAudioFormat, TtsProvider, VoiceConfig } from '../config/app-config';

export interface ResolvedCatalogSelection {
  provider: TtsProvider;
  model: string;
  quality?: string;
  gender?: string;
  voice: VoiceConfig;
  providerAudioFormat: ProviderAudioFormat;
  maxInputCharacters: number;
}

@Injectable()
export class CatalogService {
  constructor(private readonly config: AppConfig) {}

  catalog(): Record<string, unknown> {
    return {
      catalog_version: this.config.models
        .map((model) => `${model.id}:${model.provider}:${model.providerModel}`)
        .join('|'),
      providers: (['openrouter', 'speechify'] satisfies TtsProvider[]).map((provider) => ({
        id: provider,
        display_name: provider === 'openrouter' ? 'OpenRouter' : 'Speechify',
        max_input_characters: this.config.providerMaxInputCharacters(provider),
        byok_supported: true,
        backend_available: provider === 'openrouter'
          ? Boolean(this.config.openRouterApiKey)
          : Boolean(this.config.speechifyApiKey),
      })),
      models: this.config.models.map((model) => ({
        id: model.id,
        quality: model.id,
        display_name: model.displayName,
        provider: model.provider,
        model: model.providerModel,
        cache_revision: `${model.provider}:${model.providerModel}`,
        output_format: 'mp3',
        max_input_characters: model.maxInputCharacters,
        voices: model.voices.map((voice) => ({
          id: voice.id,
          gender: voice.id,
          display_name: voice.displayName,
          locale: voice.locale,
          voice: voice.providerVoice,
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
      provider: model.provider,
      model: model.providerModel,
      quality: model.id,
      gender: voice.id,
      voice,
      providerAudioFormat: model.providerAudioFormat,
      maxInputCharacters: model.maxInputCharacters,
    };
  }

  resolveDirect(provider: TtsProvider, model: string, voice: string): ResolvedCatalogSelection {
    const known = this.config.models.find(
      (candidate) => candidate.provider === provider && candidate.providerModel === model,
    );
    const knownVoice = known?.voices.find((candidate) => candidate.providerVoice === voice);
    return {
      provider,
      model,
      voice: knownVoice ?? { id: voice, displayName: voice, locale: '', providerVoice: voice },
      providerAudioFormat: known?.providerAudioFormat ?? 'mp3',
      maxInputCharacters: known?.maxInputCharacters ?? this.config.providerMaxInputCharacters(provider),
    };
  }
}
