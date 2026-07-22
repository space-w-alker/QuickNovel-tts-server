import { BeforeApplicationShutdown, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { ApiException } from '../common/api-error';
import { QuotaExceededError, SqliteStateStore } from '../state/sqlite-state.store';
import { AudioRecord, QuotaSnapshot } from '../state/state.types';
import { AudioStorageService } from './audio-storage.service';
import { audioCacheKey, CHUNKER_VERSION, normalizeText, textHash } from './cache-key';
import { CatalogService, ResolvedCatalogSelection } from './catalog.service';
import { ResolveChunkDto } from './dto';
import { SpeechGenerator } from './speech-generator';

export interface TtsHttpResult {
  status: HttpStatus.OK | HttpStatus.ACCEPTED;
  body: Record<string, unknown>;
}

@Injectable()
export class TtsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(TtsService.name);
  private readonly activeGenerations = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly catalog: CatalogService,
    private readonly state: SqliteStateStore,
    private readonly storage: AudioStorageService,
    private readonly generator: SpeechGenerator,
  ) {}

  resolve(installationId: string, dto: ResolveChunkDto): TtsHttpResult {
    if (dto.chunker_version !== CHUNKER_VERSION) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_chunker_version', 'This chunker version is not supported.');
    }
    const selection = this.catalog.resolve(dto.model_id, dto.voice_id);
    if (!selection) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'catalog_entry_unavailable',
        'The requested model and voice combination is unavailable.',
      );
    }
    const text = normalizeText(dto.text);
    const inputCharacters = [...text].length;
    if (inputCharacters === 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_text', 'Text must contain a speakable character.');
    }
    const settings = this.state.getOperationalSettings();
    if (inputCharacters > settings.maxChunkCharacters) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'text_too_large',
        `Text cannot exceed ${settings.maxChunkCharacters} characters.`,
      );
    }

    const cacheKey = audioCacheKey(text, selection.cacheRevision, selection.voice.id);
    const existing = this.state.getAudio(cacheKey);
    if (!settings.generationEnabled && (!existing || existing.status === 'failed')) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'generation_paused',
        'New speech generation is temporarily paused by the service operator.',
        true,
      );
    }
    let claim;
    try {
      claim = this.state.claimAudio(installationId, {
        cacheKey,
        modelId: selection.publicModelId,
        modelCacheRevision: selection.cacheRevision,
        voiceId: selection.voice.id,
        textHash: textHash(text),
        inputCharacters,
      });
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'quota_exhausted', 'Daily Cloud TTS quota has been reached.');
      }
      throw error;
    }

    if (claim.claimed) {
      this.state.recordEvent({
        severity: 'info',
        category: 'generation',
        action: 'generation_started',
        message: 'Speech generation started.',
        context: JSON.stringify({
          cacheKey: claim.record.cacheKey,
          jobId: claim.record.jobId,
          installationId,
          voiceId: claim.record.voiceId,
          inputCharacters,
        }),
      });
      const generation = this.generate(claim.record.cacheKey, text, selection);
      this.activeGenerations.add(generation);
      void generation.finally(() => this.activeGenerations.delete(generation));
    }
    return this.response(claim.record, claim.quota, !claim.claimed && claim.record.status === 'ready');
  }

  job(installationId: string, jobId: string): TtsHttpResult {
    const record = this.state.getAudioByJob(jobId);
    if (!record) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'job_not_found', 'The requested generation job was not found.');
    }
    return this.response(record, this.state.getQuota(installationId), record.status === 'ready');
  }

  readyAudio(cacheKey: string): AudioRecord {
    const record = this.state.getAudio(cacheKey);
    if (!record || record.status !== 'ready') {
      throw new ApiException(HttpStatus.NOT_FOUND, 'audio_not_found', 'The requested audio was not found.');
    }
    return record;
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.activeGenerations);
  }

  private async generate(cacheKey: string, text: string, selection: ResolvedCatalogSelection): Promise<void> {
    try {
      const result = await this.generator.generate({
        model: selection.openRouterModel,
        voice: selection.voice.id,
        text,
      });
      const bytes = await this.storage.save(cacheKey, result.audio);
      this.state.markReady(cacheKey, result.contentType, bytes);
      this.state.recordEvent({
        severity: 'info',
        category: 'generation',
        action: 'generation_completed',
        message: 'Speech generation completed.',
        context: JSON.stringify({ cacheKey, bytes, generationId: result.generationId }),
      });
      this.logger.log(`Generated audio cache_key=${cacheKey} bytes=${bytes}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown speech generation error';
      this.state.markFailed(cacheKey, 'generation_failed', 'Speech generation failed.');
      this.state.recordEvent({
        severity: 'error',
        category: 'generation',
        action: 'generation_failed',
        message: 'Speech generation failed.',
        context: JSON.stringify({ cacheKey, error: this.observableGenerationError(message) }),
      });
      this.logger.error(`Speech generation failed cache_key=${cacheKey}: ${message}`);
    }
  }

  private response(record: AudioRecord, quota: QuotaSnapshot, cacheHit: boolean): TtsHttpResult {
    if (record.status === 'failed') {
      throw new ApiException(
        HttpStatus.BAD_GATEWAY,
        record.errorCode ?? 'generation_failed',
        record.errorMessage ?? 'Speech generation failed.',
        true,
      );
    }
    if (record.status === 'generating') {
      return {
        status: HttpStatus.ACCEPTED,
        body: {
          state: 'generating',
          job_id: record.jobId,
          retry_after_ms: 750,
          cache_key: record.cacheKey,
        },
      };
    }
    const signed = this.storage.signedUrl(record.cacheKey);
    return {
      status: HttpStatus.OK,
      body: {
        state: 'ready',
        cache_key: record.cacheKey,
        cache_hit: cacheHit,
        audio: {
          url: signed.url,
          expires_at: signed.expiresAt,
          content_type: record.contentType,
          bytes: record.bytes,
        },
        quota: {
          characters_remaining: quota.charactersRemaining,
          requests_remaining: quota.requestsRemaining,
          resets_at: quota.resetsAt,
        },
      },
    };
  }

  private observableGenerationError(message: string): string {
    if (message.startsWith('OpenRouter returned ')) return message.split(':', 1)[0] ?? 'OpenRouter request failed';
    return message.slice(0, 200);
  }
}
