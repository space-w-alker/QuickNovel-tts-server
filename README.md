# QuickNovel TTS Server

NestJS/Fastify service that generates speech through OpenRouter and permanently reuses identical audio across QuickNovel installations. Metadata and quota accounting are stored in SQLite; MP3 files are stored on the server's local filesystem.

## Requirements

- Node.js 22+
- A writable persistent disk
- An OpenRouter API key with access to the configured speech model

## Setup

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Set unique, randomly generated values of at least 32 characters for `ACCESS_TOKEN_SECRET` and `AUDIO_SIGNING_SECRET`. Set `DATA_DIR` to a persistent volume. Back up both `quicknovel-tts.sqlite` and the `audio/` directory together.

Set `SUPER_ADMIN_PASSWORD` to a unique password of at least 12 characters in Dokploy (or your deployment environment). The server refuses to start without it. The default username is `superadmin`; override it with `SUPER_ADMIN_USERNAME`. Changing either value and redeploying synchronizes the seeded super-admin credentials.

## Operations console

Open `/admin` on the service domain and sign in with the environment-managed super-admin credentials. The console is rendered on the server with Handlebars and does not require a JavaScript application or external asset host.

The console provides:

- 24-hour request volume, error count, average and p95 latency, generation throughput, installation counts, and cache/storage metrics.
- Request tracing with request ID, route, status, latency, caller IP/user agent, and authenticated installation ID.
- A generation and audit event timeline, provider failures, and non-secret runtime/deployment configuration.
- A paginated audio library for playing, downloading, inspecting, and deleting every generated cache asset.
- A request-by-request generation ledger that classifies accepted requests as cache hits or misses and preserves that history even if an audio asset is later deleted.
- Installation quota inspection, daily usage resets, and credential revocation.
- Immediate controls for pausing new generations, daily per-installation quotas, maximum chunk size, log retention, failed-job cleanup, and log pruning.

Runtime changes are persisted in SQLite and audited. Pausing generation does not interrupt in-flight jobs or cached playback; it returns `503 generation_paused` only for new uncached work. Request logs never store access tokens, signed URL query parameters, refresh tokens, request bodies, or source text. Generation events retain identifiers and character counts but not source text.

Admin sessions use opaque random tokens stored as hashes, HttpOnly SameSite=Strict cookies, scrypt password hashing, CSRF protection on every mutation, security headers, and the global IP rate limit. Keep `ADMIN_SECURE_COOKIE=true` in HTTPS deployments (it is inferred automatically from an HTTPS `PUBLIC_BASE_URL`).

## Storage layout

```text
data/
  quicknovel-tts.sqlite
  audio/
    ab/
      abcdef....mp3
```

SQLite uses WAL mode. Cache keys are unique and generation claims are transactional, preventing concurrent requests from generating the same chunk more than once. Audio writes use a temporary file followed by an atomic rename.

The service also applies a global per-IP request limit, in addition to per-installation daily character and generation quotas. Configure these independently in `.env`.

## API flow

1. `POST /v1/installations` registers an anonymous app installation.
2. `POST /v1/installations/token` refreshes its short-lived access token.
3. `GET /v1/tts/catalog` returns the configured model and voices.
4. `POST /v1/tts/chunks:resolve` returns cached audio (`200`) or a generation job (`202`).
5. `GET /v1/tts/jobs/:jobId` polls generation.
6. The returned, expiring signed URL serves the MP3 from `/v1/tts/audio/:cacheKey`.

The cache identity includes normalized text, model cache revision, voice, and MP3 format. Playback speed is intentionally absent because the Android player applies it locally. Cache hits do not consume generation quota.

See [.env.example](.env.example) for catalog, quota, and server configuration.
The complete request and response contract is documented in [docs/api.md](docs/api.md).

## Verification

```bash
npm run lint
npm test
npm run test:coverage
npm run build
```

The integration suite uses a fake speech generator while exercising real Fastify routes, SQLite transactions, filesystem writes, signed audio delivery, authentication, polling, and cache reuse. It never spends OpenRouter credits.
