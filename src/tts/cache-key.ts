import { createHash } from 'node:crypto';

export const CACHE_KEY_VERSION = 'quicknovel-tts-cache-v1';
export const CHUNKER_VERSION = 1;

export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function textHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

export function audioCacheKey(normalizedText: string, modelRevision: string, voiceId: string): string {
  return createHash('sha256')
    .update([CACHE_KEY_VERSION, normalizedText, modelRevision, voiceId, 'mp3'].join('\0'))
    .digest('hex');
}
