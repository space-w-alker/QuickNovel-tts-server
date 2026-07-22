import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
// better-sqlite3 exposes a CommonJS constructor; this form works in the production build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Database = require('better-sqlite3');
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfig } from '../config/app-config';
import {
  AdminSessionRecord,
  AdminAudioRecord,
  AudioClaim,
  AudioRecord,
  DailyUsageRecord,
  EventLog,
  GenerationRequestRecord,
  HttpRequestLog,
  OperationalSettings,
  QuotaSnapshot,
} from './state.types';

export class InstallationExistsError extends Error {}
export class InvalidRefreshTokenError extends Error {}
export class QuotaExceededError extends Error {}

export interface AdminUserRecord {
  username: string;
  passwordHash: string;
}

export interface AdminOverview {
  installations: number;
  todayCharacters: number;
  todayGenerations: number;
  readyAudio: number;
  generatingAudio: number;
  failedAudio: number;
  cachedBytes: number;
  requests24h: number;
  errors24h: number;
  cacheHits24h: number;
  cacheMisses24h: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
}

export interface AdminInstallationRow {
  id: string;
  createdAt: string;
  characters: number;
  generations: number;
}

export interface AudioLibraryMetrics {
  totalRecords: number;
  ready: number;
  generating: number;
  failed: number;
  totalBytes: number;
  trackedRequests: number;
  cacheHits: number;
  cacheMisses: number;
}

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

interface AdminAudioRow extends AudioRow {
  request_count: number;
  cache_hits: number;
  cache_misses: number;
}

interface GenerationRequestRow {
  id: string;
  installation_id: string;
  cache_key: string;
  job_id: string;
  cache_hit: number;
  created_at: string;
  audio_status: AudioRecord['status'] | null;
  voice_id: string | null;
  model_id: string | null;
  input_characters: number | null;
  content_type: string | null;
  bytes: number | null;
  error_code: string | null;
  error_message: string | null;
}

@Injectable()
export class SqliteStateStore implements OnModuleInit, OnApplicationShutdown {
  private database!: Database.Database;
  private requestsSincePrune = 0;

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

  getOperationalSettings(): OperationalSettings {
    const rows = this.database.prepare('SELECT key, value FROM runtime_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const positiveInteger = (key: string, fallback: number): number => {
      const value = Number.parseInt(values.get(key) ?? '', 10);
      return Number.isSafeInteger(value) && value > 0 ? value : fallback;
    };
    return {
      generationEnabled: values.get('generation_enabled') !== 'false',
      dailyCharacterQuota: positiveInteger('daily_character_quota', this.config.dailyCharacterQuota),
      dailyGenerationQuota: positiveInteger('daily_generation_quota', this.config.dailyGenerationQuota),
      maxChunkCharacters: positiveInteger('max_chunk_characters', this.config.maxChunkCharacters),
      logRetentionDays: positiveInteger('log_retention_days', 30),
    };
  }

  updateOperationalSettings(settings: OperationalSettings): void {
    const entries: Array<[string, string]> = [
      ['generation_enabled', String(settings.generationEnabled)],
      ['daily_character_quota', String(settings.dailyCharacterQuota)],
      ['daily_generation_quota', String(settings.dailyGenerationQuota)],
      ['max_chunk_characters', String(settings.maxChunkCharacters)],
      ['log_retention_days', String(settings.logRetentionDays)],
    ];
    this.database.transaction(() => {
      const statement = this.database.prepare(
        `INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      const now = new Date().toISOString();
      for (const [key, value] of entries) statement.run(key, value, now);
    })();
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
        this.insertGenerationRequest(installationId, existing, true, now);
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
        usage.characters + record.inputCharacters > this.getOperationalSettings().dailyCharacterQuota ||
        usage.generations + 1 > this.getOperationalSettings().dailyGenerationQuota
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
      this.insertGenerationRequest(installationId, claimed, false, now);
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

  getAdminUser(username: string): AdminUserRecord | undefined {
    return this.database
      .prepare('SELECT username, password_hash AS passwordHash FROM admin_users WHERE username = ?')
      .get(username) as AdminUserRecord | undefined;
  }

  upsertAdminUser(username: string, passwordHash: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      )
      .run(username, passwordHash, now, now);
  }

  createAdminSession(tokenHash: string, username: string, csrfToken: string, expiresAt: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO admin_sessions (token_hash, username, csrf_token, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, username, csrfToken, now, expiresAt, now);
  }

  getAdminSession(tokenHash: string, now = new Date()): AdminSessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT username, csrf_token AS csrfToken, expires_at AS expiresAt
         FROM admin_sessions WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(tokenHash, now.toISOString()) as AdminSessionRecord | undefined;
    if (row) {
      this.database
        .prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?')
        .run(now.toISOString(), tokenHash);
    }
    return row;
  }

  deleteAdminSession(tokenHash: string): void {
    this.database.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredAdminSessions(now = new Date()): void {
    this.database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now.toISOString());
  }

  recordHttpRequest(log: HttpRequestLog): void {
    this.database
      .prepare(
        `INSERT INTO request_logs (
           request_id, method, path, status_code, duration_ms, ip, user_agent, installation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.requestId,
        log.method,
        log.path,
        log.statusCode,
        log.durationMs,
        log.ip,
        log.userAgent ?? null,
        log.installationId ?? null,
        log.createdAt,
      );
    this.requestsSincePrune += 1;
    if (this.requestsSincePrune >= 250) {
      this.requestsSincePrune = 0;
      this.pruneLogs(this.getOperationalSettings().logRetentionDays);
    }
  }

  recordEvent(event: Omit<EventLog, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): void {
    this.database
      .prepare(
        `INSERT INTO event_logs (id, severity, category, action, message, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id ?? randomUUID(),
        event.severity,
        event.category,
        event.action,
        event.message,
        event.context ?? null,
        event.createdAt ?? new Date().toISOString(),
      );
  }

  getAdminOverview(now = new Date()): AdminOverview {
    const today = this.dateKey(now);
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const scalar = (sql: string, ...params: unknown[]): number => {
      const row = this.database.prepare(sql).get(...params) as { value: number | null };
      return Number(row.value ?? 0);
    };
    const latencyRows = this.database
      .prepare('SELECT duration_ms AS durationMs FROM request_logs WHERE created_at >= ? ORDER BY duration_ms')
      .all(since) as Array<{ durationMs: number }>;
    const averageLatencyMs = latencyRows.length
      ? Math.round(latencyRows.reduce((sum, row) => sum + row.durationMs, 0) / latencyRows.length)
      : 0;
    const p95Index = Math.max(0, Math.ceil(latencyRows.length * 0.95) - 1);
    return {
      installations: scalar('SELECT COUNT(*) AS value FROM installations'),
      todayCharacters: scalar('SELECT SUM(characters) AS value FROM daily_usage WHERE usage_date = ?', today),
      todayGenerations: scalar('SELECT SUM(generations) AS value FROM daily_usage WHERE usage_date = ?', today),
      readyAudio: scalar("SELECT COUNT(*) AS value FROM audio_cache WHERE status = 'ready'"),
      generatingAudio: scalar("SELECT COUNT(*) AS value FROM audio_cache WHERE status = 'generating'"),
      failedAudio: scalar("SELECT COUNT(*) AS value FROM audio_cache WHERE status = 'failed'"),
      cachedBytes: scalar("SELECT SUM(bytes) AS value FROM audio_cache WHERE status = 'ready'"),
      requests24h: scalar('SELECT COUNT(*) AS value FROM request_logs WHERE created_at >= ?', since),
      errors24h: scalar('SELECT COUNT(*) AS value FROM request_logs WHERE created_at >= ? AND status_code >= 400', since),
      cacheHits24h: scalar(
        'SELECT COUNT(*) AS value FROM generation_requests WHERE created_at >= ? AND cache_hit = 1',
        since,
      ),
      cacheMisses24h: scalar(
        'SELECT COUNT(*) AS value FROM generation_requests WHERE created_at >= ? AND cache_hit = 0',
        since,
      ),
      averageLatencyMs,
      p95LatencyMs: latencyRows[p95Index]?.durationMs ?? 0,
    };
  }

  listRequestLogs(limit = 100): HttpRequestLog[] {
    return this.database
      .prepare(
        `SELECT request_id AS requestId, method, path, status_code AS statusCode, duration_ms AS durationMs,
                ip, user_agent AS userAgent, installation_id AS installationId, created_at AS createdAt
         FROM request_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as HttpRequestLog[];
  }

  listEvents(limit = 100): EventLog[] {
    return this.database
      .prepare(
        `SELECT id, severity, category, action, message, context, created_at AS createdAt
         FROM event_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as EventLog[];
  }

  listAudio(limit = 50, offset = 0, status?: AudioRecord['status']): AdminAudioRecord[] {
    const sql = `SELECT a.*,
                        COUNT(r.id) AS request_count,
                        COALESCE(SUM(CASE WHEN r.cache_hit = 1 THEN 1 ELSE 0 END), 0) AS cache_hits,
                        COALESCE(SUM(CASE WHEN r.cache_hit = 0 THEN 1 ELSE 0 END), 0) AS cache_misses
                 FROM audio_cache a
                 LEFT JOIN generation_requests r ON r.cache_key = a.cache_key
                 ${status ? 'WHERE a.status = ?' : ''}
                 GROUP BY a.cache_key
                 ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`;
    const rows = (status
      ? this.database.prepare(sql).all(status, limit, offset)
      : this.database.prepare(sql).all(limit, offset)) as AdminAudioRow[];
    return rows.map((row) => ({
      ...this.toAudioRecord(row),
      requestCount: row.request_count,
      cacheHits: row.cache_hits,
      cacheMisses: row.cache_misses,
    }));
  }

  countAudio(status?: AudioRecord['status']): number {
    const row = (status
      ? this.database.prepare('SELECT COUNT(*) AS total FROM audio_cache WHERE status = ?').get(status)
      : this.database.prepare('SELECT COUNT(*) AS total FROM audio_cache').get()) as { total: number };
    return row.total;
  }

  getAudioLibraryMetrics(): AudioLibraryMetrics {
    const audio = this.database
      .prepare(
        `SELECT COUNT(*) AS totalRecords,
                COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
                COALESCE(SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END), 0) AS generating,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(bytes), 0) AS totalBytes
         FROM audio_cache`,
      )
      .get() as Omit<AudioLibraryMetrics, 'trackedRequests' | 'cacheHits' | 'cacheMisses'>;
    const requests = this.database
      .prepare(
        `SELECT COUNT(*) AS trackedRequests,
                COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS cacheHits,
                COALESCE(SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END), 0) AS cacheMisses
         FROM generation_requests`,
      )
      .get() as Pick<AudioLibraryMetrics, 'trackedRequests' | 'cacheHits' | 'cacheMisses'>;
    return { ...audio, ...requests };
  }

  listGenerationRequests(limit = 100, offset = 0, cacheHit?: boolean): GenerationRequestRecord[] {
    const sql = `SELECT r.id, r.installation_id, r.cache_key, r.job_id, r.cache_hit, r.created_at,
                        a.status AS audio_status, a.voice_id, a.model_id, a.input_characters,
                        a.content_type, a.bytes, a.error_code, a.error_message
                 FROM generation_requests r
                 LEFT JOIN audio_cache a ON a.cache_key = r.cache_key
                 ${cacheHit === undefined ? '' : 'WHERE r.cache_hit = ?'}
                 ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    const rows = (cacheHit === undefined
      ? this.database.prepare(sql).all(limit, offset)
      : this.database.prepare(sql).all(cacheHit ? 1 : 0, limit, offset)) as GenerationRequestRow[];
    return rows.map((row) => ({
      id: row.id,
      installationId: row.installation_id,
      cacheKey: row.cache_key,
      jobId: row.job_id,
      cacheHit: row.cache_hit === 1,
      createdAt: row.created_at,
      ...(row.audio_status ? { audioStatus: row.audio_status } : {}),
      ...(row.voice_id ? { voiceId: row.voice_id } : {}),
      ...(row.model_id ? { modelId: row.model_id } : {}),
      ...(row.input_characters !== null ? { inputCharacters: row.input_characters } : {}),
      ...(row.content_type ? { contentType: row.content_type } : {}),
      ...(row.bytes !== null ? { bytes: row.bytes } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
    }));
  }

  countGenerationRequests(cacheHit?: boolean): number {
    const row = (cacheHit === undefined
      ? this.database.prepare('SELECT COUNT(*) AS total FROM generation_requests').get()
      : this.database.prepare('SELECT COUNT(*) AS total FROM generation_requests WHERE cache_hit = ?').get(cacheHit ? 1 : 0)) as {
      total: number;
    };
    return row.total;
  }

  deleteAudio(cacheKey: string): boolean {
    return this.database.prepare("DELETE FROM audio_cache WHERE cache_key = ? AND status != 'generating'").run(cacheKey)
      .changes > 0;
  }

  listInstallations(limit = 100, now = new Date()): AdminInstallationRow[] {
    return this.database
      .prepare(
        `SELECT i.id, i.created_at AS createdAt, COALESCE(u.characters, 0) AS characters,
                COALESCE(u.generations, 0) AS generations
         FROM installations i
         LEFT JOIN daily_usage u ON u.installation_id = i.id AND u.usage_date = ?
         ORDER BY i.created_at DESC LIMIT ?`,
      )
      .all(this.dateKey(now), limit) as AdminInstallationRow[];
  }

  resetInstallationUsage(id: string, now = new Date()): boolean {
    return this.database
      .prepare('DELETE FROM daily_usage WHERE installation_id = ? AND usage_date = ?')
      .run(id, this.dateKey(now)).changes > 0;
  }

  revokeInstallation(id: string): boolean {
    return this.database.prepare('DELETE FROM installations WHERE id = ?').run(id).changes > 0;
  }

  clearFailedAudio(): number {
    return this.database.prepare("DELETE FROM audio_cache WHERE status = 'failed'").run().changes;
  }

  pruneLogs(retentionDays: number): { requests: number; events: number } {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return {
      requests: this.database.prepare('DELETE FROM request_logs WHERE created_at < ?').run(cutoff).changes,
      events: this.database.prepare('DELETE FROM event_logs WHERE created_at < ?').run(cutoff).changes,
    };
  }

  databaseSizeBytes(): number {
    const pageCount = this.database.pragma('page_count', { simple: true }) as number;
    const pageSize = this.database.pragma('page_size', { simple: true }) as number;
    return pageCount * pageSize;
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

      CREATE TABLE IF NOT EXISTS generation_requests (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        cache_hit INTEGER NOT NULL CHECK(cache_hit IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS generation_requests_created_idx ON generation_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS generation_requests_cache_idx ON generation_requests(cache_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS generation_requests_hit_idx ON generation_requests(cache_hit, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES admin_users(username) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        request_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        ip TEXT NOT NULL,
        user_agent TEXT,
        installation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_logs_created_idx ON request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS request_logs_status_idx ON request_logs(status_code, created_at DESC);

      CREATE TABLE IF NOT EXISTS event_logs (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error')),
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_logs_created_idx ON event_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS event_logs_severity_idx ON event_logs(severity, created_at DESC);
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

  private insertGenerationRequest(
    installationId: string,
    record: AudioRecord,
    cacheHit: boolean,
    now: Date,
  ): void {
    this.database
      .prepare(
        `INSERT INTO generation_requests (id, installation_id, cache_key, job_id, cache_hit, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), installationId, record.cacheKey, record.jobId, cacheHit ? 1 : 0, now.toISOString());
  }

  private quotaFromUsage(usage: DailyUsageRecord, now: Date): QuotaSnapshot {
    const settings = this.getOperationalSettings();
    const reset = new Date(now);
    reset.setUTCHours(24, 0, 0, 0);
    return {
      charactersRemaining: Math.max(0, settings.dailyCharacterQuota - usage.characters),
      requestsRemaining: Math.max(0, settings.dailyGenerationQuota - usage.generations),
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
