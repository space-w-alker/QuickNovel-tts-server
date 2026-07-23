import { Injectable } from '@nestjs/common';
import { AppConfig, ProviderAudioFormat, TtsProvider } from '../config/app-config';
import { AudioTranscoder } from './audio-transcoder';

export interface SpeechGenerationRequest {
  provider: TtsProvider;
  model: string;
  voice: string;
  text: string;
  responseFormat?: ProviderAudioFormat;
}

export interface SpeechGenerationResult {
  audio: Buffer;
  contentType: string;
  generationId?: string;
  billableCharacters?: number;
}

export interface ProviderSpeechGenerator {
  generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult>;
}

@Injectable()
export class OpenRouterSpeechGenerator implements ProviderSpeechGenerator {
  constructor(
    private readonly config: AppConfig,
    private readonly transcoder: AudioTranscoder,
  ) {
  }

  async generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    if (!this.config.openRouterApiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }
    const responseFormat = request.responseFormat ?? 'mp3';
    const response = await fetch(`${this.config.openRouterBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.openRouterApiKey}`,
        'content-type': 'application/json',
        accept: responseFormat === 'pcm' ? 'audio/pcm' : 'audio/mpeg',
        ...(this.config.openRouterHttpReferer ? { 'http-referer': this.config.openRouterHttpReferer } : {}),
        'x-openrouter-title': this.config.openRouterAppTitle,
      },
      body: JSON.stringify({
        model: request.model,
        input: request.text,
        voice: request.voice,
        response_format: responseFormat,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenRouter returned ${response.status}`);
    }
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
    if (declaredLength > this.config.maxAudioBytes) {
      throw new Error(`OpenRouter audio exceeds the ${this.config.maxAudioBytes}-byte limit`);
    }
    const expectedContentTypes = responseFormat === 'pcm' ? ['audio/pcm'] : ['audio/mpeg', 'audio/mp3'];
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? expectedContentTypes[0];
    if (!expectedContentTypes.includes(contentType)) {
      throw new Error(`OpenRouter returned unsupported content type ${contentType}`);
    }
    const providerAudio = Buffer.from(await response.arrayBuffer());
    if (providerAudio.length === 0) throw new Error('OpenRouter returned an empty audio response');
    if (providerAudio.length > this.config.maxAudioBytes) {
      throw new Error(`OpenRouter audio exceeds the ${this.config.maxAudioBytes}-byte limit`);
    }
    const audio = responseFormat === 'pcm'
      ? await this.transcoder.pcmToMp3(providerAudio, this.config.maxAudioBytes)
      : providerAudio;
    return {
      audio,
      contentType: 'audio/mpeg',
      generationId: response.headers.get('x-generation-id') ?? undefined,
    };
  }
}

interface SpeechifyResponse {
  audio_data?: string;
  audio_format?: string;
  billable_characters_count?: number;
}

@Injectable()
export class SpeechifySpeechGenerator implements ProviderSpeechGenerator {
  constructor(private readonly config: AppConfig) {}

  async generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    if (!this.config.speechifyApiKey) throw new Error('SPEECHIFY_API_KEY is not configured');
    const response = await fetch(`${this.config.speechifyBaseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.speechifyApiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        input: request.text,
        voice_id: request.voice,
        model: request.model,
        audio_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Speechify returned ${response.status}`);
    }
    const payload = await response.json() as SpeechifyResponse;
    if (payload.audio_format !== 'mp3' || !payload.audio_data) {
      throw new Error('Speechify returned an invalid MP3 response');
    }
    const encoded = payload.audio_data.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error('Speechify returned invalid base64 audio');
    }
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length === 0) throw new Error('Speechify returned empty audio');
    if (audio.length > this.config.maxAudioBytes) {
      throw new Error(`Speechify audio exceeds the ${this.config.maxAudioBytes}-byte limit`);
    }
    return {
      audio,
      contentType: 'audio/mpeg',
      ...(Number.isSafeInteger(payload.billable_characters_count)
        ? { billableCharacters: payload.billable_characters_count }
        : {}),
    };
  }
}

@Injectable()
export class SpeechGenerator {
  constructor(
    private readonly openRouter: OpenRouterSpeechGenerator,
    private readonly speechify: SpeechifySpeechGenerator,
  ) {}

  generate(request: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
    return request.provider === 'speechify'
      ? this.speechify.generate(request)
      : this.openRouter.generate(request);
  }
}
