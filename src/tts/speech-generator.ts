import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

export interface SpeechGenerationRequest {
  model: string;
  voice: string;
  text: string;
}

export interface SpeechGenerationResult {
  audio: Buffer;
  contentType: string;
  generationId?: string;
}

export abstract class SpeechGenerator {
  abstract generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult>;
}

@Injectable()
export class OpenRouterSpeechGenerator extends SpeechGenerator {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    if (!this.config.openRouterApiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }
    const response = await fetch(`${this.config.openRouterBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.openRouterApiKey}`,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
        ...(this.config.openRouterHttpReferer ? { 'http-referer': this.config.openRouterHttpReferer } : {}),
        'x-openrouter-title': this.config.openRouterAppTitle,
      },
      body: JSON.stringify({
        model: request.model,
        input: request.text,
        voice: request.voice,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`OpenRouter returned ${response.status}: ${details}`);
    }
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
    if (declaredLength > this.config.maxAudioBytes) {
      throw new Error(`OpenRouter audio exceeds the ${this.config.maxAudioBytes}-byte limit`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg';
    if (contentType !== 'audio/mpeg' && contentType !== 'audio/mp3') {
      throw new Error(`OpenRouter returned unsupported content type ${contentType}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new Error('OpenRouter returned an empty audio response');
    if (audio.length > this.config.maxAudioBytes) {
      throw new Error(`OpenRouter audio exceeds the ${this.config.maxAudioBytes}-byte limit`);
    }
    return {
      audio,
      contentType: 'audio/mpeg',
      generationId: response.headers.get('x-generation-id') ?? undefined,
    };
  }
}
