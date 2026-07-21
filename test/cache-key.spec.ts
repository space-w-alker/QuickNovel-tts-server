import { audioCacheKey, normalizeText } from '../src/tts/cache-key';

describe('audioCacheKey', () => {
  it('normalizes equivalent line endings and Unicode', () => {
    const composed = normalizeText('  Caf\u00e9\r\nnext  ');
    const decomposed = normalizeText('Cafe\u0301\nnext');
    expect(composed).toBe(decomposed);
    expect(audioCacheKey(composed, 'model@1', 'alloy')).toBe(audioCacheKey(decomposed, 'model@1', 'alloy'));
  });

  it('changes for text, model revision, or voice, with no speed input', () => {
    const base = audioCacheKey('Hello.', 'model@1', 'alloy');
    expect(audioCacheKey('Hello!', 'model@1', 'alloy')).not.toBe(base);
    expect(audioCacheKey('Hello.', 'model@2', 'alloy')).not.toBe(base);
    expect(audioCacheKey('Hello.', 'model@1', 'nova')).not.toBe(base);
  });
});
