import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
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
