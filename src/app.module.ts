import { Module } from '@nestjs/common';
import { AccessTokenService } from './auth/access-token.service';
import { AuthGuard } from './auth/auth.guard';
import { InstallationsController } from './auth/installations.controller';
import { AppConfig } from './config/app-config';
import { HealthController } from './health.controller';
import { SqliteStateStore } from './state/sqlite-state.store';
import { AudioStorageService } from './tts/audio-storage.service';
import { CatalogController } from './tts/catalog.controller';
import { CatalogService } from './tts/catalog.service';
import { OpenRouterSpeechGenerator, SpeechGenerator } from './tts/speech-generator';
import { TtsController } from './tts/tts.controller';
import { TtsService } from './tts/tts.service';

@Module({
  controllers: [HealthController, InstallationsController, CatalogController, TtsController],
  providers: [
    AppConfig,
    SqliteStateStore,
    AccessTokenService,
    AuthGuard,
    CatalogService,
    AudioStorageService,
    TtsService,
    OpenRouterSpeechGenerator,
    { provide: SpeechGenerator, useExisting: OpenRouterSpeechGenerator },
  ],
})
export class AppModule {}
