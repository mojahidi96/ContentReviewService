# Architecture

## System context

```
┌──────────────────┐  HTTPS (cookies, CSRF, SSE)  ┌────────────────────────────┐  private HTTP (bearer)  ┌────────────────────┐
│ ContentReviewUI  │ ───────────────────────────▶ │ ContentReviewService (this) │ ──────────────────────▶ │ Python LLM service │──▶ OpenAI
│ Angular          │ ◀─────────────────────────── │ Node.js · Express · Mongo   │ ◀────────────────────── │ FastAPI (separate) │
└──────────────────┘                              └─────────────┬──────────────┘                          └────────────────────┘
                                                                │
                                                          ┌─────▼─────┐
                                                          │  MongoDB  │
                                                          └───────────┘
```

The browser only talks to Node.js. Node.js only knows the Python service through the
documented contract (`docs/python-service-contract.md`) and its Zod schemas.

## Code layout

| Path                           | Responsibility                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `src/server.ts`                | Process bootstrap: env, DB, indexes, HTTP server, worker, graceful shutdown          |
| `src/worker.ts`                | Standalone worker process (no HTTP)                                                  |
| `src/container.ts`             | Composition root: constructs and injects every dependency                            |
| `src/app.ts`                   | Express app and middleware order                                                     |
| `src/config/`                  | Env validation (Zod), logger (Pino with redaction), MongoDB connection               |
| `src/middleware/`              | request id, session loading/auth, CSRF, origin check, rate limit, validation, errors |
| `src/modules/auth`, `users`    | Registration, login, sessions, JWT cookies                                           |
| `src/modules/reviews/`         | Review API, state machines, processor (orchestration), event store, SSE              |
| `src/modules/health/`          | Liveness and readiness                                                               |
| `src/integrations/python-llm/` | `PythonLlmClient` interface, HTTP + mock implementations, schemas, errors            |
| `src/infrastructure/jobs/`     | Durable MongoDB job queue, worker loop, recovery sweep                               |
| `src/infrastructure/events/`   | In-process wake-up bus, SSE helpers and connection registry                          |
| `src/infrastructure/metrics/`  | Metrics hook interface                                                               |
| `src/shared/`                  | Errors, offsets, hashing, backoff, ids                                               |

No module-level singletons: tests build isolated containers with mock clients.

## Request pipeline

`requestId → pino-http → metrics → helmet → /health → CORS → origin check → rate limit →
JSON body (size-limited) → cookie parser → session loader → routes (requireAuth, CSRF,
validation) → 404 → error handler`.

## Authentication

- JWT (HS256, `iss`/`aud`/`exp`, `sub` = user id, `jti` = session id) in an HttpOnly cookie
  scoped to `/api`. The JWT is never returned in a body.
- **Server-side sessions** (`sessions` collection, TTL index): every authenticated request
  checks the session exists, so logout and future "log out everywhere" are immediate. This costs
  one indexed lookup per request — an intentional trade for real revocation.
- bcrypt (cost 12) password hashes. Login always runs a bcrypt comparison (against a dummy hash
  for unknown emails) and returns a single generic error, so neither the response nor its
  timing reveals whether an account exists. Registration does reveal duplicates (`409`); this is
  a deliberate UX trade-off, mitigated by the auth rate limiter.

## CSRF

Signed double-submit cookie via `csrf-csrf`:

- The CSRF cookie holds `HMAC(secret, sessionIdentifier + random)`; the token is returned in
  JSON and echoed by the client in `X-CSRF-Token`.
- The session identifier is the session id (after login) or a random anonymous id stored in an
  HttpOnly cookie (before login). A token minted for one browser/session cannot be used in
  another, which defeats cookie-tossing and login-CSRF.
- Required on all unsafe methods, including login/register. Tokens rotate on login/register.
- Defense in depth: `SameSite=Lax` cookies and an `Origin`/`Referer` allowlist check. CORS is
  not relied upon for CSRF protection.

Deployment assumptions: UI and API are served from the **same site** (e.g. `app.example.com`
and `api.example.com`, or a reverse proxy path) so `SameSite=Lax` cookies flow. For a
cross-site deployment set `AUTH_COOKIE_SAMESITE=none` + `AUTH_COOKIE_SECURE=true`; CSRF tokens
then become the primary defense (they remain required either way). Over HTTPS, prefer a
`__Host-` CSRF cookie name.

## Review processing

```
POST /reviews ──▶ Review(pending) + Job(queued) ──▶ 202
                                  │
          worker claims job (lease) ─▶ Review(processing, jobAttempt=n)
                                  │      └─ event: review.started, review.progress(analyzing)
                                  ▼
                     PythonLlmClient.analyze()  ── retryable error ─▶ Job(queued, runAfter=backoff)
                                  │                                    └─ event: review.progress(retrying)
                                  │            ── permanent / exhausted ─▶ Review(failed) ─▶ event: review.failed
                                  ▼
         validate schema + offsets + categories, dedupe, stable finding ids
                                  ▼
         Review(completed, findings)  ──▶ events: finding.detected × N, review.completed
```

### Durable job queue (MongoDB)

Chosen over BullMQ/Redis to avoid a second datastore; MongoDB already provides durability and
atomic single-document updates.

- One job per review (unique `reviewId`): enqueue is idempotent.
- `claim()` atomically takes a queued job whose `runAfter` has passed **or** a running job whose
  lease (`lockedUntil`) has expired, setting `lockedBy` and incrementing `attempts`.
- The worker renews the lease every `lease/3` while processing. Every job transition is
  conditional on `(lockedBy, attempts)`, so a worker that lost its lease cannot change the job.
- Retryable errors (timeouts, 5xx, 429, malformed output, unexpected errors) are rescheduled
  with exponential backoff + jitter (respecting `Retry-After`) up to `JOB_MAX_ATTEMPTS`.
  Non-retryable errors (Python 4xx) fail immediately.
- Graceful shutdown waits `SHUTDOWN_GRACE_MS`, then aborts in-flight calls and releases jobs
  back to the queue without consuming an attempt.
- Workers run in the API process (`WORKER_ENABLED=true`) or as separate processes
  (`npm run start:worker`); any number of workers can run concurrently.

### Correctness under failures

| Scenario                                 | Handling                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Process crash mid-analysis               | Lease expires → another worker re-claims (attempt n+1)                        |
| Crash on the final attempt               | Re-claimed with `attempts > maxAttempts` → review failed `PROCESSING_TIMEOUT` |
| Stale worker finishes after losing lease | Review update is conditional on `jobAttempt`; result discarded                |
| Crash after persisting, before events    | Re-delivery sees terminal review → republishes missing events (idempotent)    |
| Crash between creating review and job    | Recovery sweep finds stale `pending` review without job → enqueues            |
| Job finished but review not terminal     | Recovery sweep fails the review with `PROCESSING_TIMEOUT`                     |
| Duplicate delivery of a completed job    | No LLM call; findings and events unchanged                                    |
| Review deleted mid-processing            | Conditional writes match nothing; event appends are skipped                   |

Retries never duplicate findings: finding ids are `sha256(reviewId, category, start, end,
originalText)`, duplicates collapse, and the findings array is replaced atomically.

## Events and SSE

- Events are appended to `review_events` **after** the state they describe is persisted.
  Each has a per-review sequence number (`seq`, the SSE `id`, allocated with `$inc` on the
  review) and a `dedupeKey` (unique per review) that makes appends idempotent.
- SSE handler: check ownership → replay `seq > Last-Event-ID` → tail new events → close after a
  terminal event. New events are picked up via an in-process wake-up (same-process latency ≈ 0)
  **and** a DB poll every `SSE_POLL_INTERVAL_MS`, so streams work when the worker runs in a
  different process or instance. The poll also detects deletion.
- Heartbeat comments keep proxies from closing idle connections. Listeners, timers and
  registry entries are removed on client disconnect; shutdown closes all streams.
- Delivery is **at-least-once with replay**, not exactly-once. Clients dedupe by event id /
  `findingId`, and can always rebuild state from `GET /reviews/:id`.
- The processing job never depends on an SSE connection.

## Data model

| Collection      | Notes                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | unique lower-cased `email`; `passwordHash` excluded from queries by default                                                                                                                                                |
| `sessions`      | `_id` = JWT `jti`; TTL on `expiresAt`                                                                                                                                                                                      |
| `reviews`       | owner `userId`; `content`, `contentHash` (sha256), `contentLength`; embedded `findings`; `eventSeq`, `jobAttempt`; TTL on `expiresAt`. Indexes `{userId, createdAt}`, `{userId, status, createdAt}`, `{status, updatedAt}` |
| `review_events` | unique `{reviewId, seq}` and `{reviewId, dedupeKey}`; TTL on `expiresAt` (same as review)                                                                                                                                  |
| `review_jobs`   | unique `reviewId`; `{status, runAfter}`, `{status, lockedUntil}`; finished jobs TTL 7 days                                                                                                                                 |

Findings are embedded: they are always read and written with their review, are bounded
(≤ 1000), and updates use positional operators conditioned on the current status.

## Data minimization and retention

- Content is stored because the UI must render findings against it after a refresh. It is
  never logged; neither are passwords, cookies, tokens, CSRF tokens or finding text (Pino
  redaction + serializers that log only method, path and status).
- Reviews, their events (and therefore content and findings) expire after
  `REVIEW_RETENTION_DAYS` (TTL index; `0` disables). `DELETE /reviews/:id` removes them
  immediately. Finished job records expire after 7 days and contain no content.
- `contentHash` allows future deduplication/caching without comparing raw content.
- Account deletion is not yet exposed; when added it must delete the user's reviews, events,
  jobs and sessions.

## Observability

- Structured JSON logs (Pino) with `req.id` = `X-Request-Id`; job logs carry `reviewId`,
  `jobId`, `attempt`. The review id is forwarded to Python as `X-Request-Id`.
- `/health/live` (process) and `/health/ready` (MongoDB ping; Python health reported but not
  gating; `503` while shutting down).
- `MetricsRecorder` hooks: HTTP latency by route, job outcomes and durations, LLM call
  outcomes/latency, active SSE connections. The default implementation logs; plug in
  Prometheus/OpenTelemetry by implementing the interface in `src/infrastructure/metrics/`.

## Scaling notes

- API instances are stateless apart from SSE connections; any instance can serve any stream.
- Rate limiting uses an in-memory store per instance. Behind multiple instances, configure a
  shared store (e.g. `rate-limit-mongo` / Redis) or enforce limits at the gateway.
- SSE polling cost is one indexed query per open stream per poll interval. For very large
  numbers of streams, replace polling with MongoDB change streams (requires a replica set)
  behind the same `EventBus` wake-up interface.
