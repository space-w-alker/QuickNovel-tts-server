import { createHash } from 'node:crypto';

export const CACHE_KEY_VERSION = 'quicknovel-tts-cache-v4';
export const CHUNKER_VERSION = 2;

export function prepareSpeechText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function normalizeText(text: string): string {
  return prepareSpeechText(text)
    .toLowerCase()
    .replace(/\p{White_Space}+/gu, '')
    .normalize('NFC');
}

export function textHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

export function audioCacheKey(normalizedText: string, provider: string, model: string, voice: string): string {
  return createHash('sha256')
    .update([CACHE_KEY_VERSION, normalizedText, provider, model, voice, 'mp3'].join('\0'))
    .digest('hex');
}
