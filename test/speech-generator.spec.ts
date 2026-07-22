import { afterEach, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config';
import { AudioTranscoder } from '../src/tts/audio-transcoder';
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
    const pcmToMp3 = vi.fn();
    const transcoder = { pcmToMp3 } as AudioTranscoder;
    const generator = new OpenRouterSpeechGenerator({
      openRouterApiKey: 'openrouter-key',
      openRouterBaseUrl: 'https://openrouter.example/api/v1',
      openRouterAppTitle: 'QuickNovel',
      openRouterHttpReferer: undefined,
      maxAudioBytes: 1024,
    } as AppConfig, transcoder);

    const result = await generator.generate({
      model: 'provider/model', voice: 'alloy', text: 'Hello.', responseFormat: 'mp3',
    });

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
    expect(pcmToMp3).not.toHaveBeenCalled();
  });

  it('requests PCM and normalizes it to MP3', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from('pcm'), { status: 200, headers: { 'content-type': 'audio/pcm' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pcmToMp3 = vi.fn().mockResolvedValue(Buffer.from('normalized-mp3'));
    const transcoder = { pcmToMp3 } as AudioTranscoder;
    const generator = new OpenRouterSpeechGenerator({
      openRouterApiKey: 'openrouter-key',
      openRouterBaseUrl: 'https://openrouter.example/api/v1',
      openRouterAppTitle: 'QuickNovel',
      maxAudioBytes: 1024,
    } as AppConfig, transcoder);

    const result = await generator.generate({
      model: 'google/model', voice: 'Puck', text: 'Hello.', responseFormat: 'pcm',
    });

    expect(result.audio).toEqual(Buffer.from('normalized-mp3'));
    expect(result.contentType).toBe('audio/mpeg');
    expect(pcmToMp3).toHaveBeenCalledWith(Buffer.from('pcm'), 1024);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string).response_format).toBe('pcm');
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
    } as AppConfig, { pcmToMp3: vi.fn() });
    await expect(generator.generate({
      model: 'model', voice: 'voice', text: 'Hello.', responseFormat: 'mp3',
    })).rejects.toThrow(
      'unsupported content type',
    );
  });
});
