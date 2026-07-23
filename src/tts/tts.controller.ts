import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ApiException } from '../common/api-error';
import { AudioStorageService } from './audio-storage.service';
import { ResolveChunkDto } from './dto';
import { TtsService } from './tts.service';

@Controller('v1/tts')
export class TtsController {
  constructor(
    private readonly tts: TtsService,
    private readonly storage: AudioStorageService,
  ) {}

  @Post('chunks:resolve')
  @UseGuards(AuthGuard)
  resolve(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ResolveChunkDto,
    @Res() reply: FastifyReply,
  ): void {
    const result = this.tts.resolve(request.installationId, dto);
    void reply.status(result.status).send(result.body);
  }

  @Get('jobs/:jobId')
  @UseGuards(AuthGuard)
  job(@Req() request: AuthenticatedRequest, @Param('jobId') jobId: string, @Res() reply: FastifyReply): void {
    const result = this.tts.job(request.installationId, jobId);
    void reply.status(result.status).send(result.body);
  }

  @Post('chunks/upload')
  @UseGuards(AuthGuard)
  async upload(
    @Req() request: AuthenticatedRequest & FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let metadata: ResolveChunkDto | undefined;
    let audio: Buffer | undefined;
    for await (const part of request.parts({
      limits: { files: 1, fields: 1, fileSize: 50 * 1024 * 1024 },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio' || !['audio/mpeg', 'audio/mp3'].includes(part.mimetype)) {
          throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio_upload', 'A single MP3 audio file is required.');
        }
        const chunks: Buffer[] = [];
        for await (const chunk of part.file as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        audio = Buffer.concat(chunks);
      } else if (part.fieldname === 'metadata') {
        try {
          metadata = JSON.parse(String(part.value)) as ResolveChunkDto;
        } catch {
          throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_upload_metadata', 'Upload metadata must be valid JSON.');
        }
      }
    }
    if (!metadata || !audio) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_audio_upload', 'Metadata and MP3 audio are required.');
    }
    const result = await this.tts.upload(request.installationId, metadata, audio);
    void reply.status(result.status).send(result.body);
  }

  @Get('audio/:cacheKey')
  audio(
    @Param('cacheKey') cacheKey: string,
    @Query('expires') expires: string | undefined,
    @Query('signature') signature: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    if (!this.storage.verify(cacheKey, expires, signature)) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'invalid_audio_signature', 'The audio URL is invalid or expired.');
    }
    const record = this.tts.readyAudio(cacheKey);
    void reply.type(record.contentType ?? 'audio/mpeg').header('content-length', record.bytes).send(this.storage.stream(cacheKey));
  }
}
