import { audioCacheKey, CACHE_KEY_VERSION, normalizeText, prepareSpeechText } from '../src/tts/cache-key';

describe('audioCacheKey', () => {
  it('normalizes equivalent line endings and Unicode', () => {
    const composed = normalizeText('  Caf\u00e9\r\nnext  ');
    const decomposed = normalizeText('Cafe\u0301\nnext');
    expect(composed).toBe(decomposed);
    expect(audioCacheKey(composed, 'model@1', 'alloy')).toBe(audioCacheKey(decomposed, 'model@1', 'alloy'));
  });

  it('removes all Unicode whitespace and ignores case while preserving punctuation', () => {
    const decorated = normalizeText('  Hello,\tWORLD!\r\nCafé—test…  ');
    expect(decorated).toBe('hello,world!café—test…');
    expect(decorated).toBe(normalizeText('hello, world! cafe\u0301—test…'));
    expect(audioCacheKey(decorated, 'model@1', 'alloy')).toBe(
      audioCacheKey(normalizeText('HELLO, WORLD! CAFÉ—TEST…'), 'model@1', 'alloy'),
    );
    expect(audioCacheKey(normalizeText('Hello world.'), 'model@1', 'alloy')).not.toBe(
      audioCacheKey(normalizeText('Hello, world!'), 'model@1', 'alloy'),
    );
  });

  it('preserves natural text for speech generation', () => {
    expect(prepareSpeechText('  Hello,\tWORLD!\r\nNext line.  ')).toBe('Hello,\tWORLD!\nNext line.');
  });

  it('changes for meaningful text, model revision, or voice, with no speed input', () => {
    const base = audioCacheKey(normalizeText('Hello.'), 'model@1', 'alloy');
    expect(audioCacheKey(normalizeText('Goodbye.'), 'model@1', 'alloy')).not.toBe(base);
    expect(audioCacheKey(normalizeText('Hello.'), 'model@2', 'alloy')).not.toBe(base);
    expect(audioCacheKey(normalizeText('Hello.'), 'model@1', 'nova')).not.toBe(base);
    expect(CACHE_KEY_VERSION).toBe('quicknovel-tts-cache-v3');
  });
});
