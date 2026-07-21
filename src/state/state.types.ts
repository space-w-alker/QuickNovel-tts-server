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
