import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { AccessTokenPayload } from './auth.types';

@Injectable()
export class AccessTokenService {
  constructor(private readonly config: AppConfig) {}

  create(installationId: string, now = new Date()): { token: string; expiresAt: string } {
    const expiresAt = Math.floor(now.getTime() / 1000) + this.config.accessTokenTtlSeconds;
    const payload = Buffer.from(JSON.stringify({ installationId, expiresAt } satisfies AccessTokenPayload)).toString(
      'base64url',
    );
    return {
      token: `${payload}.${this.sign(payload)}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  verify(token: string, now = new Date()): AccessTokenPayload | undefined {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return undefined;
    const expected = this.sign(payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessTokenPayload;
      if (!parsed.installationId || parsed.expiresAt <= Math.floor(now.getTime() / 1000)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.accessTokenSecret).update(payload).digest('base64url');
  }
}
