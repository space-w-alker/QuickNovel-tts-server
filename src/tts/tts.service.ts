import { BeforeApplicationShutdown, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { ApiException } from '../common/api-error';
import { QuotaExceededError, SqliteStateStore } from '../state/sqlite-state.store';
import { AudioRecord, QuotaSnapshot } from '../state/state.types';
import { AudioStorageService } from './audio-storage.service';
import { AudioTranscoder } from './audio-transcoder';
import { audioCacheKey, CHUNKER_VERSION, normalizeText, prepareSpeechText, textHash } from './cache-key';
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
    private readonly transcoder: AudioTranscoder,
  ) {}

  resolve(installationId: string, dto: ResolveChunkDto): TtsHttpResult {
    if (![1, CHUNKER_VERSION].includes(dto.chunker_version)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_chunker_version', 'This chunker version is not supported.');
    }
    const selection = this.selection(dto);
    const speechText = prepareSpeechText(dto.text);
    const normalizedText = normalizeText(speechText);
    const inputCharacters = [...speechText].length;
    if (inputCharacters === 0 || normalizedText.length === 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_text', 'Text must contain a speakable character.');
    }
    const settings = this.state.getOperationalSettings();
    const maximumCharacters = Math.min(settings.maxChunkCharacters, selection.maxInputCharacters);
    if (inputCharacters > maximumCharacters) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'text_too_large_for_provider',
        `Text cannot exceed ${maximumCharacters} characters for ${selection.provider}.`,
      );
    }

    const cacheKey = audioCacheKey(normalizedText, selection.provider, selection.model, selection.voice.providerVoice);
    const existing = this.state.getAudio(cacheKey);
    if (existing && existing.status !== 'failed') {
      const claim = this.state.claimAudio(installationId, {
        cacheKey,
        providerId: selection.provider,
        generationSource: existing.generationSource,
        modelId: selection.model,
        modelCacheRevision: `${selection.provider}:${selection.model}`,
        voiceId: selection.voice.providerVoice,
        textHash: textHash(normalizedText),
        inputCharacters,
      });
      return this.response(claim.record, claim.quota, true);
    }
    if (dto.generation_source === 'byok') {
      return {
        status: HttpStatus.OK,
        body: {
          state: 'upload_required',
          cache_key: cacheKey,
          selection: {
            provider: selection.provider,
            model: selection.model,
            voice: selection.voice.providerVoice,
          },
        },
      };
    }
    const approval = this.state.getInstallationStatus(installationId);
    if (approval !== 'approved') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        approval === 'suspended' ? 'backend_generation_suspended' : 'backend_generation_approval_required',
        approval === 'suspended'
          ? 'Backend speech generation is suspended for this installation.'
          : 'An administrator must approve this installation before backend speech generation.',
      );
    }
    if (
      (selection.provider === 'openrouter' && !this.config.openRouterApiKey)
      || (selection.provider === 'speechify' && !this.config.speechifyApiKey)
    ) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'provider_not_configured',
        `${selection.provider} backend generation is not configured.`,
        true,
      );
    }
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
        providerId: selection.provider,
        generationSource: 'backend',
        modelId: selection.model,
        modelCacheRevision: `${selection.provider}:${selection.model}`,
        voiceId: selection.voice.providerVoice,
        textHash: textHash(normalizedText),
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
      const generation = this.generate(claim.record.cacheKey, speechText, selection);
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
        provider: selection.provider,
        model: selection.model,
        voice: selection.voice.providerVoice,
        text,
        responseFormat: selection.providerAudioFormat,
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
    if (message.startsWith('Speechify returned ')) return message.split(':', 1)[0] ?? 'Speechify request failed';
    return message.slice(0, 200);
  }

  async upload(installationId: string, dto: ResolveChunkDto, audio: Buffer): Promise<TtsHttpResult> {
    if (![1, CHUNKER_VERSION].includes(dto.chunker_version)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_chunker_version', 'This chunker version is not supported.');
    }
    if (typeof dto.text !== 'string') {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_upload_metadata', 'Upload text must be a string.');
    }
    const selection = this.selection(dto);
    const speechText = prepareSpeechText(dto.text);
    const normalizedText = normalizeText(speechText);
    const inputCharacters = [...speechText].length;
    const maximumCharacters = Math.min(
      this.state.getOperationalSettings().maxChunkCharacters,
      selection.maxInputCharacters,
    );
    if (!normalizedText || inputCharacters > maximumCharacters) {
      throw new ApiException(
        inputCharacters > maximumCharacters ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
        inputCharacters > maximumCharacters ? 'text_too_large_for_provider' : 'invalid_text',
        inputCharacters > maximumCharacters
          ? `Text cannot exceed ${maximumCharacters} characters for ${selection.provider}.`
          : 'Text must contain a speakable character.',
      );
    }
    if (!audio.length || audio.length > this.config.maxAudioBytes) {
      throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'invalid_audio_upload', 'Uploaded MP3 is empty or too large.');
    }
    try {
      await this.transcoder.validateMp3(audio);
    } catch {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio_upload', 'Uploaded audio is not a valid MP3.');
    }
    const cacheKey = audioCacheKey(normalizedText, selection.provider, selection.model, selection.voice.providerVoice);
    const existing = this.state.getAudio(cacheKey);
    if (existing && existing.status !== 'failed') {
      return this.response(existing, this.state.getQuota(installationId), true);
    }
    if (existing?.status === 'failed') {
      this.state.deleteAudio(cacheKey);
      await this.storage.remove(cacheKey);
    }
    const saved = await this.storage.saveIfAbsent(cacheKey, audio);
    const registered = this.state.registerUploadedAudio(installationId, {
      cacheKey,
      providerId: selection.provider,
      generationSource: 'byok',
      modelId: selection.model,
      modelCacheRevision: `${selection.provider}:${selection.model}`,
      voiceId: selection.voice.providerVoice,
      textHash: textHash(normalizedText),
      inputCharacters,
    }, saved.bytes);
    return this.response(registered.record, this.state.getQuota(installationId), !registered.inserted);
  }

  private selection(dto: ResolveChunkDto): ResolvedCatalogSelection {
    const presetPair = Boolean(dto.quality || dto.gender);
    const directPair = Boolean(dto.provider || dto.model || dto.voice);
    const legacyPair = Boolean(dto.model_id || dto.voice_id);
    if ([presetPair, directPair, legacyPair].filter(Boolean).length !== 1) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'invalid_tts_selection',
        'Send exactly one complete quality/gender or provider/model/voice selection.',
      );
    }
    if (directPair) {
      const provider = dto.provider;
      const model = typeof dto.model === 'string' ? dto.model.trim() : '';
      const voice = typeof dto.voice === 'string' ? dto.voice.trim() : '';
      if (
        (provider !== 'openrouter' && provider !== 'speechify')
        || !model || !voice || model.length > 200 || voice.length > 200
      ) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_tts_selection', 'Provider, model and voice are required.');
      }
      return this.catalog.resolveDirect(provider, model, voice);
    }
    const rawQuality = dto.quality ?? dto.model_id;
    const rawGender = dto.gender ?? dto.voice_id;
    const quality = typeof rawQuality === 'string' ? rawQuality.trim() : '';
    const gender = typeof rawGender === 'string' ? rawGender.trim() : '';
    if (!quality || !gender || quality.length > 100 || gender.length > 100) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_tts_selection', 'Quality and gender are required.');
    }
    const selection = this.catalog.resolve(quality, gender);
    if (!selection) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'catalog_entry_unavailable',
        'The requested quality and gender combination is unavailable.',
      );
    }
    return selection;
  }
}
