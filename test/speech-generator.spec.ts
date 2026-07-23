import { afterEach, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config';
import { AudioTranscoder } from '../src/tts/audio-transcoder';
import { OpenRouterSpeechGenerator, SpeechGenerator, SpeechifySpeechGenerator } from '../src/tts/speech-generator';
import { SpeechifyRequestQueue } from '../src/tts/speechify-request-queue';

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
      provider: 'openrouter', model: 'provider/model', voice: 'alloy', text: 'Hello.', responseFormat: 'mp3',
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
      provider: 'openrouter', model: 'google/model', voice: 'Puck', text: 'Hello.', responseFormat: 'pcm',
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
      provider: 'openrouter', model: 'model', voice: 'voice', text: 'Hello.', responseFormat: 'mp3',
    })).rejects.toThrow(
      'unsupported content type',
    );
  });
});

describe('SpeechifySpeechGenerator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function speechifyConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      speechifyApiKey: 'speechify-key',
      speechifyBaseUrl: 'https://speechify.example',
      speechifyRequestsPerSecond: 1,
      speechifyMaxConcurrentRequests: 1,
      maxAudioBytes: 1024,
      ...overrides,
    } as AppConfig;
  }

  function speechifyGenerator(config = speechifyConfig()): SpeechifySpeechGenerator {
    return new SpeechifySpeechGenerator(config, new SpeechifyRequestQueue(config));
  }

  it('requests and decodes Speechify MP3 audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      audio_data: Buffer.from('speechify-mp3').toString('base64'),
      audio_format: 'mp3',
      billable_characters_count: 6,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const generator = speechifyGenerator();

    const result = await generator.generate({
      provider: 'speechify', model: 'simba-3.0', voice: 'george', text: 'Hello.',
    });

    expect(result.audio).toEqual(Buffer.from('speechify-mp3'));
    expect(result.billableCharacters).toBe(6);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://speechify.example/v1/audio/speech');
    expect(JSON.parse(options.body as string)).toEqual({
      input: 'Hello.',
      voice_id: 'george',
      model: 'simba-3.0',
      audio_format: 'mp3',
    });
  });

  it('rejects malformed Speechify audio data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      audio_data: 'not-base64!',
      audio_format: 'mp3',
    }), { status: 200 })));
    const generator = speechifyGenerator();
    await expect(generator.generate({
      provider: 'speechify', model: 'simba-3.0', voice: 'george', text: 'Hello.',
    })).rejects.toThrow('invalid base64');
  });

  it('queues request starts at the configured sustained rate', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      audio_data: Buffer.from('speechify-mp3').toString('base64'),
      audio_format: 'mp3',
    }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const generator = speechifyGenerator();
    const request = {
      provider: 'speechify' as const,
      model: 'simba-3.2',
      voice: 'geffen_32',
      text: 'Hello.',
    };

    const generations = [
      generator.generate(request),
      generator.generate(request),
      generator.generate(request),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(Promise.all(generations)).resolves.toHaveLength(3);
  });

  it('does not exceed the configured request concurrency', async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const config = speechifyConfig({
      speechifyRequestsPerSecond: 1000,
      speechifyMaxConcurrentRequests: 1,
    });
    const generator = speechifyGenerator(config);
    const request = {
      provider: 'speechify' as const,
      model: 'simba-3.2',
      voice: 'geffen_32',
      text: 'Hello.',
    };

    const first = generator.generate(request);
    const second = generator.generate(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    responses.shift()?.(new Response(JSON.stringify({
      audio_data: Buffer.from('first').toString('base64'),
      audio_format: 'mp3',
    }), { status: 200 }));
    await expect(first).resolves.toMatchObject({ audio: Buffer.from('first') });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    responses.shift()?.(new Response(JSON.stringify({
      audio_data: Buffer.from('second').toString('base64'),
      audio_format: 'mp3',
    }), { status: 200 }));
    await expect(second).resolves.toMatchObject({ audio: Buffer.from('second') });
  });
});

describe('SpeechGenerator', () => {
  it('dispatches generation by canonical provider', async () => {
    const openRouter = { generate: vi.fn().mockResolvedValue({ audio: Buffer.from('or') }) };
    const speechify = { generate: vi.fn().mockResolvedValue({ audio: Buffer.from('sf') }) };
    const generator = new SpeechGenerator(
      openRouter as unknown as OpenRouterSpeechGenerator,
      speechify as unknown as SpeechifySpeechGenerator,
    );
    await generator.generate({ provider: 'openrouter', model: 'm', voice: 'v', text: 'one' });
    await generator.generate({ provider: 'speechify', model: 'm', voice: 'v', text: 'two' });
    expect(openRouter.generate).toHaveBeenCalledOnce();
    expect(speechify.generate).toHaveBeenCalledOnce();
  });
});
