export interface InstallationRecord {
  id: string;
  refreshTokenHash: string;
  createdAt: string;
}

export interface DailyUsageRecord {
  characters: number;
  generations: number;
}

export type AudioStatus = 'generating' | 'ready' | 'failed';

export interface AudioRecord {
  cacheKey: string;
  jobId: string;
  status: AudioStatus;
  modelId: string;
  modelCacheRevision: string;
  voiceId: string;
  textHash: string;
  inputCharacters: number;
  createdAt: string;
  updatedAt: string;
  contentType?: string;
  bytes?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface PersistedState {
  installations: Record<string, InstallationRecord>;
  usage: Record<string, Record<string, DailyUsageRecord>>;
  audio: Record<string, AudioRecord>;
  jobs: Record<string, string>;
}

export interface QuotaSnapshot {
  charactersRemaining: number;
  requestsRemaining: number;
  resetsAt: string;
}

export interface AudioClaim {
  claimed: boolean;
  record: AudioRecord;
  quota: QuotaSnapshot;
}

export interface OperationalSettings {
  generationEnabled: boolean;
  dailyCharacterQuota: number;
  dailyGenerationQuota: number;
  maxChunkCharacters: number;
  logRetentionDays: number;
}

export interface AdminSessionRecord {
  username: string;
  csrfToken: string;
  expiresAt: string;
}

export interface HttpRequestLog {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
  userAgent?: string;
  installationId?: string;
  createdAt: string;
}

export interface EventLog {
  id: string;
  severity: 'info' | 'warning' | 'error';
  category: string;
  action: string;
  message: string;
  context?: string;
  createdAt: string;
}

export interface GenerationRequestRecord {
  id: string;
  installationId: string;
  cacheKey: string;
  jobId: string;
  cacheHit: boolean;
  createdAt: string;
  audioStatus?: AudioStatus;
  voiceId?: string;
  modelId?: string;
  inputCharacters?: number;
  contentType?: string;
  bytes?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface AdminAudioRecord extends AudioRecord {
  requestCount: number;
  cacheHits: number;
  cacheMisses: number;
}
