import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-error';
import { SqliteStateStore } from '../state/sqlite-state.store';
import { AccessTokenService } from './access-token.service';
import { AuthenticatedRequest } from './auth.types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly state: SqliteStateStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const payload = value?.startsWith('Bearer ') ? this.tokens.verify(value.slice(7)) : undefined;
    if (!payload || !this.state.hasInstallation(payload.installationId)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'unauthorized', 'A valid installation token is required.');
    }
    request.installationId = payload.installationId;
    return true;
  }
}
