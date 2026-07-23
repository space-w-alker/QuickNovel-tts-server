import { Module } from '@nestjs/common';
import { AdminAuthService } from './admin/admin-auth.service';
import { AdminController } from './admin/admin.controller';
import { AdminRendererService } from './admin/admin-renderer.service';
import { AccessTokenService } from './auth/access-token.service';
import { AuthGuard } from './auth/auth.guard';
import { InstallationsController } from './auth/installations.controller';
import { AppConfig } from './config/app-config';
import { HealthController } from './health.controller';
import { SqliteStateStore } from './state/sqlite-state.store';
import { AudioStorageService } from './tts/audio-storage.service';
import { AudioTranscoder } from './tts/audio-transcoder';
import { CatalogController } from './tts/catalog.controller';
import { CatalogService } from './tts/catalog.service';
import { OpenRouterSpeechGenerator, SpeechGenerator, SpeechifySpeechGenerator } from './tts/speech-generator';
import { SpeechifyRequestQueue } from './tts/speechify-request-queue';
import { TtsController } from './tts/tts.controller';
import { TtsService } from './tts/tts.service';

@Module({
  controllers: [AdminController, HealthController, InstallationsController, CatalogController, TtsController],
  providers: [
    AppConfig,
    SqliteStateStore,
    AdminAuthService,
    AdminRendererService,
    AccessTokenService,
    AuthGuard,
    CatalogService,
    AudioStorageService,
    AudioTranscoder,
    TtsService,
    OpenRouterSpeechGenerator,
    SpeechifyRequestQueue,
    SpeechifySpeechGenerator,
    SpeechGenerator,
  ],
})
export class AppModule {}
