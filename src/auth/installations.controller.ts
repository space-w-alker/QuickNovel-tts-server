import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiException } from '../common/api-error';
import {
  InstallationExistsError,
  InvalidRefreshTokenError,
  SqliteStateStore,
} from '../state/sqlite-state.store';
import { AccessTokenService } from './access-token.service';
import { RefreshInstallationDto, RegisterInstallationDto } from './dto';

@Controller('v1/installations')
export class InstallationsController {
  constructor(
    private readonly state: SqliteStateStore,
    private readonly tokens: AccessTokenService,
  ) {}

  @Post()
  register(@Body() dto: RegisterInstallationDto): Record<string, unknown> {
    try {
      const { refreshToken } = this.state.registerInstallation(dto.installation_id);
      return this.response(dto.installation_id, refreshToken);
    } catch (error) {
      if (error instanceof InstallationExistsError) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'installation_exists',
          'This installation is already registered; refresh its access token instead.',
        );
      }
      throw error;
    }
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshInstallationDto): Record<string, unknown> {
    try {
      this.state.verifyRefreshToken(dto.installation_id, dto.refresh_token);
      return this.response(dto.installation_id);
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        throw new ApiException(HttpStatus.UNAUTHORIZED, 'unauthorized', 'The installation credentials are invalid.');
      }
      throw error;
    }
  }

  private response(installationId: string, refreshToken?: string): Record<string, unknown> {
    const access = this.tokens.create(installationId);
    const quota = this.state.getQuota(installationId);
    return {
      access_token: access.token,
      access_token_expires_at: access.expiresAt,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      quota: {
        characters_remaining: quota.charactersRemaining,
        requests_remaining: quota.requestsRemaining,
        resets_at: quota.resetsAt,
      },
    };
  }
}
