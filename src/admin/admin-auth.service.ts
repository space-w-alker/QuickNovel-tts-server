import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppConfig } from '../config/app-config';
import { SqliteStateStore } from '../state/sqlite-state.store';
import { AdminSessionRecord } from '../state/state.types';

const scrypt = promisify(nodeScrypt);

@Injectable()
export class AdminAuthService implements OnModuleInit {
  static readonly cookieName = 'quicknovel_admin_session';

  constructor(
    private readonly config: AppConfig,
    private readonly state: SqliteStateStore,
  ) {}

  async onModuleInit(): Promise<void> {
    const current = this.state.getAdminUser(this.config.superAdminUsername);
    if (!current || !(await this.verifyPassword(this.config.superAdminPassword, current.passwordHash))) {
      this.state.upsertAdminUser(
        this.config.superAdminUsername,
        await this.hashPassword(this.config.superAdminPassword),
      );
    }
    this.state.deleteExpiredAdminSessions();
  }

  async login(username: string, password: string): Promise<{ token: string; session: AdminSessionRecord } | undefined> {
    if (username !== this.config.superAdminUsername) return undefined;
    const user = this.state.getAdminUser(username);
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) return undefined;
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.adminSessionTtlSeconds * 1000).toISOString();
    this.state.createAdminSession(this.tokenHash(token), username, csrfToken, expiresAt);
    return { token, session: { username, csrfToken, expiresAt } };
  }

  session(token: string | undefined): AdminSessionRecord | undefined {
    if (!token) return undefined;
    return this.state.getAdminSession(this.tokenHash(token));
  }

  logout(token: string | undefined): void {
    if (token) this.state.deleteAdminSession(this.tokenHash(token));
  }

  validCsrf(session: AdminSessionRecord, provided: unknown): boolean {
    if (typeof provided !== 'string' || provided.length !== session.csrfToken.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(session.csrfToken));
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [algorithm, saltValue, hashValue] = stored.split('$');
    if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
    try {
      const expected = Buffer.from(hashValue, 'base64url');
      const actual = (await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length)) as Buffer;
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
