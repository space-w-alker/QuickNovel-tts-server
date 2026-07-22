import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config/app-config';
import { SqliteStateStore } from '../state/sqlite-state.store';
import { AdminSessionRecord, AudioSortField, OperationalSettings, SortDirection } from '../state/state.types';
import { AudioStorageService } from '../tts/audio-storage.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminRendererService } from './admin-renderer.service';

type FormBody = Record<string, string | undefined>;
type CookieRequest = FastifyRequest & { cookies: Record<string, string | undefined> };

@Controller('admin')
export class AdminController {
  constructor(
    private readonly config: AppConfig,
    private readonly state: SqliteStateStore,
    private readonly auth: AdminAuthService,
    private readonly renderer: AdminRendererService,
    private readonly storage: AudioStorageService,
  ) {}

  @Get('login')
  loginPage(@Req() request: CookieRequest, @Query('error') error: string | undefined, @Res() reply: FastifyReply): void {
    if (this.auth.session(request.cookies[AdminAuthService.cookieName])) {
      void reply.status(302).redirect('/admin/overview');
      return;
    }
    void reply.type('text/html; charset=utf-8').send(
      this.renderer.renderLogin({ error: error === 'invalid', username: this.config.superAdminUsername }),
    );
  }

  @Post('login')
  async login(@Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply): Promise<void> {
    const username = String(body.username ?? '').trim();
    const result = await this.auth.login(username, String(body.password ?? ''));
    if (!result) {
      this.state.recordEvent({
        severity: 'warning', category: 'security', action: 'login_failed', message: 'Admin login failed.',
        context: JSON.stringify({ username, ip: request.ip }),
      });
      void reply.status(302).redirect('/admin/login?error=invalid');
      return;
    }
    this.state.recordEvent({
      severity: 'info', category: 'security', action: 'login', message: 'Admin signed in.',
      context: JSON.stringify({ username: result.session.username, ip: request.ip }),
    });
    void reply
      .status(302)
      .setCookie(AdminAuthService.cookieName, result.token, {
        path: '/admin', httpOnly: true, sameSite: 'strict', secure: this.config.secureAdminCookie,
        maxAge: this.config.adminSessionTtlSeconds,
      })
      .redirect('/admin/overview');
  }

  @Post('logout')
  logout(@Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const token = request.cookies[AdminAuthService.cookieName];
    const session = this.auth.session(token);
    if (session && this.auth.validCsrf(session, body.csrf_token)) {
      this.auth.logout(token);
      this.state.recordEvent({ severity: 'info', category: 'security', action: 'logout', message: 'Admin signed out.' });
    }
    void reply.status(302).clearCookie(AdminAuthService.cookieName, { path: '/admin' }).redirect('/admin/login');
  }

  @Get()
  index(@Res() reply: FastifyReply): void {
    void reply.status(302).redirect('/admin/overview');
  }

  @Get('overview')
  overview(@Req() request: CookieRequest, @Query('notice') notice: string | undefined, @Res() reply: FastifyReply): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    this.page(reply, 'overview', session, {
      active: 'overview', overview: this.state.getAdminOverview(), settings: this.state.getOperationalSettings(),
      events: this.decorateEvents(this.state.listEvents(8)), requests: this.state.listRequestLogs(8),
      notice: this.notice(notice),
    });
  }

  @Get('requests')
  requests(@Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    this.page(reply, 'requests', session, { active: 'requests', requests: this.state.listRequestLogs(250) });
  }

  @Get('events')
  events(@Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    this.page(reply, 'events', session, { active: 'events', events: this.decorateEvents(this.state.listEvents(250)) });
  }

  @Get('audio')
  audio(
    @Req() request: CookieRequest,
    @Query('status') rawStatus: string | undefined,
    @Query('sort') rawSort: string | undefined,
    @Query('direction') rawDirection: string | undefined,
    @Query('page') rawPage: string | undefined,
    @Query('notice') notice: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    const status = rawStatus === 'ready' || rawStatus === 'generating' || rawStatus === 'failed' ? rawStatus : undefined;
    const sort: AudioSortField = rawSort === 'cacheHits' || rawSort === 'size' ? rawSort : 'updated';
    const direction: SortDirection = rawDirection === 'asc' ? 'asc' : 'desc';
    const page = this.pageNumber(rawPage);
    const pageSize = 50;
    const total = this.state.countAudio(status);
    const audio = this.state.listAudio(pageSize, (page - 1) * pageSize, status, sort, direction).map((record) => ({
      ...record,
      ...(record.status === 'ready' ? { playbackUrl: this.storage.signedUrl(record.cacheKey).url } : {}),
    }));
    const filterParams = { ...(status ? { status } : {}), sort, direction };
    const audioUrl = (params: Record<string, string>): string => {
      const query = new URLSearchParams(params);
      return `/admin/audio${query.size ? `?${query.toString()}` : ''}`;
    };
    const sortUrl = (field: AudioSortField): string => audioUrl({
      ...(status ? { status } : {}),
      sort: field,
      direction: sort === field && direction === 'desc' ? 'asc' : 'desc',
    });
    this.page(reply, 'audio', session, {
      active: 'audio', audio, metrics: this.state.getAudioLibraryMetrics(),
      status: status ?? 'all', sort, direction, notice: this.notice(notice),
      updatedSortUrl: sortUrl('updated'),
      cacheHitsSortUrl: sortUrl('cacheHits'),
      sizeSortUrl: sortUrl('size'),
      updatedSortIndicator: sort === 'updated' ? (direction === 'asc' ? '↑' : '↓') : '',
      cacheHitsSortIndicator: sort === 'cacheHits' ? (direction === 'asc' ? '↑' : '↓') : '',
      sizeSortIndicator: sort === 'size' ? (direction === 'asc' ? '↑' : '↓') : '',
      allStatusUrl: audioUrl({ sort, direction }),
      readyStatusUrl: audioUrl({ status: 'ready', sort, direction }),
      generatingStatusUrl: audioUrl({ status: 'generating', sort, direction }),
      failedStatusUrl: audioUrl({ status: 'failed', sort, direction }),
      ...this.pagination(page, pageSize, total, '/admin/audio', filterParams),
    });
  }

  @Get('generation-requests')
  generationRequests(
    @Req() request: CookieRequest,
    @Query('outcome') rawOutcome: string | undefined,
    @Query('page') rawPage: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    const outcome = rawOutcome === 'hit' || rawOutcome === 'miss' ? rawOutcome : undefined;
    const cacheHit = outcome === undefined ? undefined : outcome === 'hit';
    const page = this.pageNumber(rawPage);
    const pageSize = 100;
    const total = this.state.countGenerationRequests(cacheHit);
    const generationRequests = this.state
      .listGenerationRequests(pageSize, (page - 1) * pageSize, cacheHit)
      .map((record) => ({
        ...record,
        ...(record.audioStatus === 'ready' ? { playbackUrl: this.storage.signedUrl(record.cacheKey).url } : {}),
      }));
    this.page(reply, 'generation-requests', session, {
      active: 'generation-requests', generationRequests, outcome: outcome ?? 'all',
      ...this.pagination(page, pageSize, total, '/admin/generation-requests', outcome ? { outcome } : {}),
    });
  }

  @Get('installations')
  installations(
    @Req() request: CookieRequest,
    @Query('notice') notice: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    this.page(reply, 'installations', session, {
      active: 'installations', installations: this.state.listInstallations(250), notice: this.notice(notice),
    });
  }

  @Get('settings')
  settings(
    @Req() request: CookieRequest,
    @Query('notice') notice: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    this.page(reply, 'settings', session, {
      active: 'settings', settings: this.state.getOperationalSettings(), notice: this.notice(notice),
      defaults: {
        dailyCharacterQuota: this.config.dailyCharacterQuota,
        dailyGenerationQuota: this.config.dailyGenerationQuota,
        maxChunkCharacters: this.config.maxChunkCharacters,
      },
    });
  }

  @Get('system')
  system(@Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requireSession(request, reply);
    if (!session) return;
    const memory = process.memoryUsage();
    this.page(reply, 'system', session, {
      active: 'system',
      system: {
        node: process.version, environment: process.env.NODE_ENV ?? 'development', uptimeSeconds: Math.round(process.uptime()),
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, databaseBytes: this.state.databaseSizeBytes(),
        publicBaseUrl: this.config.publicBaseUrl, dataDir: this.config.dataDir, models: this.config.models,
        openRouterConfigured: Boolean(this.config.openRouterApiKey),
        rateLimit: `${this.config.rateLimitMax} / ${this.config.rateLimitWindow}`,
        accessTokenTtlSeconds: this.config.accessTokenTtlSeconds,
        audioUrlTtlSeconds: this.config.audioUrlTtlSeconds,
        secureCookie: this.config.secureAdminCookie,
      },
    });
  }

  @Post('settings')
  updateSettings(@Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const settings: OperationalSettings = {
      generationEnabled: body.generation_enabled === 'on',
      dailyCharacterQuota: this.integer(body.daily_character_quota, 1, 100_000_000),
      dailyGenerationQuota: this.integer(body.daily_generation_quota, 1, 1_000_000),
      maxChunkCharacters: this.integer(body.max_chunk_characters, 100, 50_000),
      logRetentionDays: this.integer(body.log_retention_days, 1, 365),
    };
    this.state.updateOperationalSettings(settings);
    this.audit(session, 'settings_updated', 'Runtime settings were updated.', settings);
    void reply.status(302).redirect('/admin/settings?notice=settings-saved');
  }

  @Post('audio/clear-failed')
  clearFailed(@Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const removed = this.state.clearFailedAudio();
    this.audit(session, 'failed_audio_cleared', 'Failed audio records were cleared.', { removed });
    void reply.status(302).redirect('/admin/audio?status=failed&notice=failed-cleared');
  }

  @Post('audio/:cacheKey/delete')
  async deleteAudio(
    @Param('cacheKey') cacheKey: string,
    @Body() body: FormBody,
    @Req() request: CookieRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const record = this.state.getAudio(cacheKey);
    if (!record) {
      void reply.status(404).type('text/plain').send('Audio record not found.');
      return;
    }
    if (record.status === 'generating') {
      void reply.status(409).type('text/plain').send('An in-flight generation cannot be deleted.');
      return;
    }
    const fileRemoved = await this.storage.remove(cacheKey);
    const metadataRemoved = this.state.deleteAudio(cacheKey);
    this.audit(session, 'audio_deleted', 'Cached audio and its metadata were deleted.', {
      cacheKey, status: record.status, bytes: record.bytes, fileRemoved, metadataRemoved,
    });
    void reply.status(302).redirect('/admin/audio?notice=audio-deleted');
  }

  @Post('installations/:id/reset-usage')
  resetUsage(
    @Param('id') id: string, @Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply,
  ): void {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const changed = this.state.resetInstallationUsage(id);
    this.audit(session, 'installation_usage_reset', 'Installation daily usage was reset.', { id, changed });
    void reply.status(302).redirect('/admin/installations?notice=usage-reset');
  }

  @Post('installations/:id/revoke')
  revokeInstallation(
    @Param('id') id: string, @Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply,
  ): void {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const changed = this.state.revokeInstallation(id);
    this.audit(session, 'installation_revoked', 'Installation credentials and usage were revoked.', { id, changed });
    void reply.status(302).redirect('/admin/installations?notice=installation-revoked');
  }

  @Post('logs/prune')
  pruneLogs(@Body() body: FormBody, @Req() request: CookieRequest, @Res() reply: FastifyReply): void {
    const session = this.requirePostSession(request, reply, body);
    if (!session) return;
    const result = this.state.pruneLogs(this.state.getOperationalSettings().logRetentionDays);
    this.audit(session, 'logs_pruned', 'Expired request and event logs were pruned.', result);
    void reply.status(302).redirect('/admin/settings?notice=logs-pruned');
  }

  private requireSession(request: CookieRequest, reply: FastifyReply): AdminSessionRecord | undefined {
    const session = this.auth.session(request.cookies[AdminAuthService.cookieName]);
    if (!session) {
      void reply.status(302).redirect('/admin/login');
      return undefined;
    }
    return session;
  }

  private requirePostSession(
    request: CookieRequest,
    reply: FastifyReply,
    body: FormBody,
  ): AdminSessionRecord | undefined {
    const session = this.requireSession(request, reply);
    if (!session) return undefined;
    if (!this.auth.validCsrf(session, body.csrf_token)) {
      void reply.status(403).type('text/plain').send('Invalid or expired CSRF token. Reload the page and try again.');
      return undefined;
    }
    return session;
  }

  private page(
    reply: FastifyReply,
    template: string,
    session: AdminSessionRecord,
    data: Record<string, unknown>,
  ): void {
    void reply.type('text/html; charset=utf-8').send(this.renderer.render(template, {
      ...data, username: session.username, csrfToken: session.csrfToken, renderedAt: new Date().toISOString(),
    }));
  }

  private integer(value: string | undefined, minimum: number, maximum: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`Value must be an integer between ${minimum} and ${maximum}.`);
    }
    return parsed;
  }

  private pageNumber(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '1', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  private pagination(
    page: number,
    pageSize: number,
    total: number,
    path: string,
    filters: Record<string, string>,
  ): Record<string, unknown> {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const url = (targetPage: number): string => {
      const params = new URLSearchParams({ ...filters, page: String(targetPage) });
      return `${path}?${params.toString()}`;
    };
    return {
      page,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      previousUrl: page > 1 ? url(page - 1) : undefined,
      nextUrl: page < totalPages ? url(page + 1) : undefined,
    };
  }

  private audit(session: AdminSessionRecord, action: string, message: string, context: unknown): void {
    this.state.recordEvent({
      severity: 'info', category: 'admin', action, message,
      context: JSON.stringify({ actor: session.username, ...(context as Record<string, unknown>) }),
    });
  }

  private decorateEvents(events: ReturnType<SqliteStateStore['listEvents']>): Array<Record<string, unknown>> {
    return events.map((event) => {
      let contextDisplay = event.context ?? '';
      try {
        contextDisplay = event.context ? JSON.stringify(JSON.parse(event.context), null, 2) : '';
      } catch { /* retain original context */ }
      return { ...event, contextDisplay };
    });
  }

  private notice(value: string | undefined): string | undefined {
    const messages: Record<string, string> = {
      'settings-saved': 'Runtime settings saved and active immediately.',
      'failed-cleared': 'Failed audio records cleared; clients can request those chunks again.',
      'audio-deleted': 'The cached audio file and metadata were deleted. Its request history was preserved.',
      'usage-reset': "Today's usage was reset for the installation.",
      'installation-revoked': 'Installation credentials were revoked.',
      'logs-pruned': 'Logs older than the retention window were pruned.',
    };
    return value ? messages[value] : undefined;
  }
}
