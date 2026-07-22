import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';

@Injectable()
export class AudioTranscoder {
  pcmToMp3(pcm: Buffer, maxOutputBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const process = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          's16le',
          '-ar',
          '24000',
          '-ac',
          '1',
          '-i',
          'pipe:0',
          '-codec:a',
          'libmp3lame',
          '-b:a',
          '96k',
          '-f',
          'mp3',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        finish(new Error('PCM to MP3 transcoding timed out'));
      }, 60_000);

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(Buffer.concat(output));
      };

      process.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          process.kill('SIGKILL');
          finish(new Error(`Transcoded audio exceeds the ${maxOutputBytes}-byte limit`));
          return;
        }
        output.push(chunk);
      });
      process.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      process.on('error', (error) => finish(new Error(`Unable to start ffmpeg: ${error.message}`)));
      process.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const details = Buffer.concat(errors).toString('utf8').trim().slice(0, 500);
          finish(new Error(`PCM to MP3 transcoding failed${details ? `: ${details}` : ''}`));
          return;
        }
        if (outputBytes === 0) {
          finish(new Error('PCM to MP3 transcoding returned empty audio'));
          return;
        }
        finish();
      });
      process.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error);
      });
      process.stdin.end(pcm);
    });
  }
}
