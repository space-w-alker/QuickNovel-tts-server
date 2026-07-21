# API contract

All JSON endpoints are under `/v1`. Except for registration/token refresh and signed audio delivery, send the installation access token as `Authorization: Bearer <token>`.

All errors have this shape:

```json
{
  "error": {
    "code": "quota_exhausted",
    "message": "Daily Cloud TTS quota has been reached.",
    "retryable": false
  }
}
```

## Register an installation

`POST /v1/installations`

```json
{
  "installation_id": "2f4d50c0-d489-4a60-8ea8-bfb5a660ddef",
  "app_version": "3.6.1",
  "platform": "android"
}
```

Returns `201` with a short-lived `access_token`, its `access_token_expires_at`, a long-lived `refresh_token`, and the current quota. Registration is rejected with `409 installation_exists` if the UUID already exists.

## Refresh an access token

`POST /v1/installations/token`

```json
{
  "installation_id": "2f4d50c0-d489-4a60-8ea8-bfb5a660ddef",
  "refresh_token": "the-registration-refresh-token"
}
```

Returns `200` with a new access token and current quota. The refresh token is not rotated in v1.

## Get the TTS catalog

`GET /v1/tts/catalog`

```json
{
  "catalog_version": "openai/gpt-4o-mini-tts-2025-12-15@1",
  "models": [
    {
      "id": "quicknovel-default",
      "display_name": "QuickNovel Voice",
      "cache_revision": "openai/gpt-4o-mini-tts-2025-12-15@1",
      "output_format": "mp3",
      "voices": [{ "id": "alloy", "display_name": "Alloy", "locale": "en-US" }]
    }
  ]
}
```

Only model/voice combinations in this response can be resolved.

## Resolve a speech chunk

`POST /v1/tts/chunks:resolve`

```json
{
  "model_id": "quicknovel-default",
  "voice_id": "alloy",
  "text": "The exact sentence to speak.",
  "chunker_version": 1
}
```

On a cache miss, returns `202`:

```json
{
  "state": "generating",
  "job_id": "caf419ea-12e7-4227-97e1-8fa26936f410",
  "retry_after_ms": 750,
  "cache_key": "64-character-sha256"
}
```

On a cache hit, returns `200`:

```json
{
  "state": "ready",
  "cache_key": "64-character-sha256",
  "cache_hit": true,
  "audio": {
    "url": "https://server/v1/tts/audio/...?...",
    "expires_at": "2026-07-21T12:15:00.000Z",
    "content_type": "audio/mpeg",
    "bytes": 123456
  },
  "quota": {
    "characters_remaining": 99970,
    "requests_remaining": 999,
    "resets_at": "2026-07-22T00:00:00.000Z"
  }
}
```

The server normalizes Unicode and line endings, then derives the cache identity from text, model cache revision, voice, and MP3 format. Playback speed is not accepted and cannot affect cache identity. Only a newly claimed generation consumes daily quota; cache hits and job polling do not.

## Poll a generation job

`GET /v1/tts/jobs/{job_id}`

Returns `202` while generation is active and the same `200 ready` response after completion. Failed jobs return `502 generation_failed`. A later resolve request may retry a failed cache entry and consumes quota as a new generation attempt.

## Download audio

Use the URL returned in the ready response. It is an expiring HMAC-signed `GET /v1/tts/audio/{cache_key}` URL and does not require the bearer token. Expired or modified URLs return `403 invalid_audio_signature`.

The underlying MP3 remains stored permanently; URL expiry controls access, not retention.
