import { afterEach, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config';
import { OpenRouterSpeechGenerator } from '../src/tts/speech-generator';

describe('OpenRouterSpeechGenerator', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the speech endpoint with MP3 output and no synthesis speed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('mp3'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'generation-1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const generator = new OpenRouterSpeechGenerator({
      openRouterApiKey: 'openrouter-key',
      openRouterBaseUrl: 'https://openrouter.example/api/v1',
      openRouterAppTitle: 'QuickNovel',
      openRouterHttpReferer: undefined,
      maxAudioBytes: 1024,
    } as AppConfig);

    const result = await generator.generate({ model: 'provider/model', voice: 'alloy', text: 'Hello.' });

    expect(result.audio).toEqual(Buffer.from('mp3'));
    expect(result.generationId).toBe('generation-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.example/api/v1/audio/speech');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'provider/model',
      input: 'Hello.',
      voice: 'alloy',
      response_format: 'mp3',
    });
  });

  it('rejects unsupported content types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const generator = new OpenRouterSpeechGenerator({
      openRouterApiKey: 'openrouter-key',
      openRouterBaseUrl: 'https://openrouter.example/api/v1',
      openRouterAppTitle: 'QuickNovel',
      maxAudioBytes: 1024,
    } as AppConfig);
    await expect(generator.generate({ model: 'model', voice: 'voice', text: 'Hello.' })).rejects.toThrow(
      'unsupported content type',
    );
  });
});
