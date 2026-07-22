import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import Database = require('better-sqlite3');
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfig } from '../config/app-config';
import { AudioClaim, AudioRecord, DailyUsageRecord, QuotaSnapshot } from './state.types';

export class InstallationExistsError extends Error {}
export class InvalidRefreshTokenError extends Error {}
export class QuotaExceededError extends Error {}

interface AudioRow {
  cache_key: string;
  job_id: string;
  status: AudioRecord['status'];
  model_id: string;
  model_cache_revision: string;
  voice_id: string;
  text_hash: string;
  input_characters: number;
  created_at: string;
  updated_at: string;
  content_type: string | null;
  bytes: number | null;
  error_code: string | null;
  error_message: string | null;
}

@Injectable()
export class SqliteStateStore implements OnModuleInit, OnApplicationShutdown {
  private database!: Database.Database;

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    mkdirSync(this.config.dataDir, { recursive: true });
    this.database = new Database(join(this.config.dataDir, 'quicknovel-tts.sqlite'));
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.migrate();
    this.database
      .prepare(
        `UPDATE audio_cache
         SET status = 'failed', error_code = 'generation_interrupted',
             error_message = 'Generation was interrupted by a server restart.', updated_at = ?
         WHERE status = 'generating'`,
      )
      .run(new Date().toISOString());
  }

  onApplicationShutdown(): void {
    this.database?.close();
  }

  registerInstallation(id: string): { refreshToken: string } {
    const refreshToken = randomBytes(32).toString('base64url');
    try {
      this.database
        .prepare('INSERT INTO installations (id, refresh_token_hash, created_at) VALUES (?, ?, ?)')
        .run(id, this.hash(refreshToken), new Date().toISOString());
      return { refreshToken };
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new InstallationExistsError();
      }
      throw error;
    }
  }

  hasInstallation(id: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM installations WHERE id = ?').get(id));
  }

  verifyRefreshToken(id: string, refreshToken: string): void {
    const row = this.database
      .prepare('SELECT refresh_token_hash AS refreshTokenHash FROM installations WHERE id = ?')
      .get(id) as { refreshTokenHash: string } | undefined;
    const actual = this.hash(refreshToken);
    if (
      !row ||
      row.refreshTokenHash.length !== actual.length ||
      !timingSafeEqual(Buffer.from(row.refreshTokenHash), Buffer.from(actual))
    ) {
      throw new InvalidRefreshTokenError();
    }
  }

  getQuota(id: string, now = new Date()): QuotaSnapshot {
    const usage = (this.database
      .prepare(
        `SELECT characters, generations
         FROM daily_usage WHERE installation_id = ? AND usage_date = ?`,
      )
      .get(id, this.dateKey(now)) ?? { characters: 0, generations: 0 }) as DailyUsageRecord;
    return this.quotaFromUsage(usage, now);
  }

  getAudio(cacheKey: string): AudioRecord | undefined {
    const row = this.database.prepare('SELECT * FROM audio_cache WHERE cache_key = ?').get(cacheKey) as
      | AudioRow
      | undefined;
    return row ? this.toAudioRecord(row) : undefined;
  }

  getAudioByJob(jobId: string): AudioRecord | undefined {
    const row = this.database.prepare('SELECT * FROM audio_cache WHERE job_id = ?').get(jobId) as
      | AudioRow
      | undefined;
    return row ? this.toAudioRecord(row) : undefined;
  }

  claimAudio(
    installationId: string,
    record: Omit<AudioRecord, 'jobId' | 'status' | 'createdAt' | 'updatedAt'>,
    now = new Date(),
  ): AudioClaim {
    return this.database.transaction(() => {
      const existing = this.getAudio(record.cacheKey);
      if (existing && existing.status !== 'failed') {
        return { claimed: false, record: existing, quota: this.getQuota(installationId, now) };
      }

      const date = this.dateKey(now);
      const usage = (this.database
        .prepare(
          `SELECT characters, generations
           FROM daily_usage WHERE installation_id = ? AND usage_date = ?`,
        )
        .get(installationId, date) ?? { characters: 0, generations: 0 }) as DailyUsageRecord;
      if (
        usage.characters + record.inputCharacters > this.config.dailyCharacterQuota ||
        usage.generations + 1 > this.config.dailyGenerationQuota
      ) {
        throw new QuotaExceededError();
      }

      this.database
        .prepare(
          `INSERT INTO daily_usage (installation_id, usage_date, characters, generations)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(installation_id, usage_date) DO UPDATE SET
             characters = excluded.characters,
             generations = excluded.generations`,
        )
        .run(installationId, date, usage.characters + record.inputCharacters, usage.generations + 1);

      const timestamp = now.toISOString();
      const claimed: AudioRecord = {
        ...record,
        jobId: randomUUID(),
        status: 'generating',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      this.database
        .prepare(
          `INSERT INTO audio_cache (
             cache_key, job_id, status, model_id, model_cache_revision, voice_id, text_hash,
             input_characters, created_at, updated_at, content_type, bytes, error_code, error_message
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
           ON CONFLICT(cache_key) DO UPDATE SET
             job_id = excluded.job_id, status = excluded.status, updated_at = excluded.updated_at,
             content_type = NULL, bytes = NULL, error_code = NULL, error_message = NULL`,
        )
        .run(
          claimed.cacheKey,
          claimed.jobId,
          claimed.status,
          claimed.modelId,
          claimed.modelCacheRevision,
          claimed.voiceId,
          claimed.textHash,
          claimed.inputCharacters,
          claimed.createdAt,
          claimed.updatedAt,
        );
      return { claimed: true, record: claimed, quota: this.getQuota(installationId, now) };
    }).immediate();
  }

  markReady(cacheKey: string, contentType: string, bytes: number): AudioRecord {
    this.database
      .prepare(
        `UPDATE audio_cache SET status = 'ready', content_type = ?, bytes = ?,
         error_code = NULL, error_message = NULL, updated_at = ? WHERE cache_key = ?`,
      )
      .run(contentType, bytes, new Date().toISOString(), cacheKey);
    return this.requireAudio(cacheKey);
  }

  markFailed(cacheKey: string, code: string, message: string): AudioRecord {
    this.database
      .prepare(
        `UPDATE audio_cache SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
         WHERE cache_key = ?`,
      )
      .run(code, message, new Date().toISOString(), cacheKey);
    return this.requireAudio(cacheKey);
  }

  private requireAudio(cacheKey: string): AudioRecord {
    const record = this.getAudio(cacheKey);
    if (!record) throw new Error(`Unknown audio cache key ${cacheKey}`);
    return record;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        id TEXT PRIMARY KEY,
        refresh_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_usage (
        installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
        usage_date TEXT NOT NULL,
        characters INTEGER NOT NULL CHECK(characters >= 0),
        generations INTEGER NOT NULL CHECK(generations >= 0),
        PRIMARY KEY (installation_id, usage_date)
      );

      CREATE TABLE IF NOT EXISTS audio_cache (
        cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
        job_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('generating', 'ready', 'failed')),
        model_id TEXT NOT NULL,
        model_cache_revision TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        input_characters INTEGER NOT NULL CHECK(input_characters > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_type TEXT,
        bytes INTEGER,
        error_code TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS audio_cache_status_idx ON audio_cache(status);
    `);
  }

  private toAudioRecord(row: AudioRow): AudioRecord {
    return {
      cacheKey: row.cache_key,
      jobId: row.job_id,
      status: row.status,
      modelId: row.model_id,
      modelCacheRevision: row.model_cache_revision,
      voiceId: row.voice_id,
      textHash: row.text_hash,
      inputCharacters: row.input_characters,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.content_type ? { contentType: row.content_type } : {}),
      ...(row.bytes !== null ? { bytes: row.bytes } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    };
  }

  private quotaFromUsage(usage: DailyUsageRecord, now: Date): QuotaSnapshot {
    const reset = new Date(now);
    reset.setUTCHours(24, 0, 0, 0);
    return {
      charactersRemaining: Math.max(0, this.config.dailyCharacterQuota - usage.characters),
      requestsRemaining: Math.max(0, this.config.dailyGenerationQuota - usage.generations),
      resetsAt: reset.toISOString(),
    };
  }

  private dateKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
