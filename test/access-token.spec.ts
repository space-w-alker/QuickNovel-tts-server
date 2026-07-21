import { AccessTokenService } from '../src/auth/access-token.service';
import { AppConfig } from '../src/config/app-config';

describe('AccessTokenService', () => {
  const config = {
    accessTokenSecret: 'a'.repeat(32),
    accessTokenTtlSeconds: 60,
  } as AppConfig;
  const service = new AccessTokenService(config);

  it('accepts an unmodified token before expiry', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = service.create('install-1', now);
    expect(service.verify(result.token, new Date('2026-01-01T00:00:30Z'))?.installationId).toBe('install-1');
  });

  it('rejects expired and tampered tokens', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const result = service.create('install-1', now);
    expect(service.verify(result.token, new Date('2026-01-01T00:01:00Z'))).toBeUndefined();
    expect(service.verify(`${result.token}x`, now)).toBeUndefined();
  });
});
