# ContentReviewService

Node.js backend for the AI-powered Content Review Platform. It authenticates users, accepts
documents for grammar / spelling / profanity review, orchestrates analysis by a separate
Python LLM service, persists results in MongoDB, and streams progress and findings to the
Angular UI (`ContentReviewUI`) over Server-Sent Events.

```
Angular UI ──(cookies + CSRF + SSE)──▶ ContentReviewService ──(private HTTP + bearer)──▶ Python LLM service ──▶ OpenAI
                                              │
                                           MongoDB
```

This repository contains **only** the Node.js service. It never calls OpenAI and holds no
OpenAI key; it integrates with the Python service through a documented contract.

| Document                                                             | Audience                     |
| -------------------------------------------------------------------- | ---------------------------- |
| [`docs/api-contract.md`](docs/api-contract.md)                       | Angular UI (source of truth) |
| [`docs/python-service-contract.md`](docs/python-service-contract.md) | Python service team          |
| [`docs/architecture.md`](docs/architecture.md)                       | Backend maintainers          |

## Stack

Node.js 24 · TypeScript (strict) · Express 5 · MongoDB / Mongoose 9 · Zod 4 · JWT
(`jsonwebtoken`) in HttpOnly cookies · `csrf-csrf` · `bcryptjs` · Helmet · `express-rate-limit` ·
Pino · undici · Vitest + Supertest + `mongodb-memory-server` · ESLint + Prettier · Docker.

Key design choices (details in [architecture.md](docs/architecture.md)):

- **Durable MongoDB job queue** with leases, bounded retries and a recovery sweep — no Redis
  needed, and processing survives restarts and crashes.
- **Persisted event log** per review: SSE replays from `Last-Event-ID`, works across
  instances, and never depends on the browser staying connected.
- **Server-side sessions** behind the JWT, so logout really revokes.
- **Code-point offsets** (`[start, end)`) everywhere, matching Python `str` indexing.

## Prerequisites

- Node.js ≥ 24 and npm ≥ 10
- MongoDB 7+ (local install or Docker)
- Optional: Docker + Docker Compose
- Optional: the Python LLM service. Without it, run with `PYTHON_LLM_MODE=mock`.

## Getting started

```bash
npm ci
cp .env.example .env
```

Edit `.env`:

- For local development without the Python service set `PYTHON_LLM_MODE=mock` (a built-in,
  rule-based analyzer flags e.g. "teh", "recieve", "report have", "several mistake", "damn").
- Generate real secrets for anything beyond a laptop: `openssl rand -base64 48`.

Start MongoDB (either):

```bash
docker compose up -d mongo                         # MongoDB on 127.0.0.1:27017
# or
mongod --dbpath ./.data/db                         # local install
```

Run the API (with the in-process worker) in watch mode:

```bash
npm run dev            # http://localhost:3000
curl localhost:3000/health/ready
```

Configuration is validated at startup; the process exits with a list of invalid variable
names (never their values). See [`.env.example`](.env.example) for every setting.

### Python LLM service

Set `PYTHON_LLM_MODE=http`, `PYTHON_LLM_SERVICE_URL` (e.g. `http://localhost:8000`) and a
`PYTHON_LLM_SERVICE_TOKEN` (≥ 16 chars) that the Python service also accepts. The service must
implement `POST /internal/v1/content-reviews` and `GET /internal/v1/health` as described in
[`docs/python-service-contract.md`](docs/python-service-contract.md). If it is down, reviews
stay queued and are retried with backoff; `/health/ready` reports `degraded`.

## Scripts

| Command                           | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                     | API + worker with reload (tsx), reads `.env`                         |
| `npm run dev:worker`              | Standalone worker with reload                                        |
| `npm run build`                   | Compile to `dist/`                                                   |
| `npm start`                       | Run compiled API (`dist/server.js`; reads real env vars, not `.env`) |
| `npm run start:worker`            | Run compiled standalone worker                                       |
| `npm test`                        | Unit + integration tests                                             |
| `npm run typecheck`               | Type-check sources and tests                                         |
| `npm run lint` / `lint:fix`       | ESLint (type-aware)                                                  |
| `npm run format` / `format:check` | Prettier                                                             |
| `npm run check`                   | typecheck + lint + format check + tests                              |

## API overview

Full request/response schemas, errors and limits: [`docs/api-contract.md`](docs/api-contract.md).

| Method & path                                         | Auth | CSRF | Description                      |
| ----------------------------------------------------- | ---- | ---- | -------------------------------- |
| `GET /api/v1/auth/csrf`                               |      |      | Issue CSRF token                 |
| `POST /api/v1/auth/register`                          |      | ✓    | Create account + session         |
| `POST /api/v1/auth/login`                             |      | ✓    | Start session                    |
| `POST /api/v1/auth/logout`                            | ✓    | ✓    | Revoke session                   |
| `GET /api/v1/auth/me`                                 | ✓    |      | Current user                     |
| `POST /api/v1/reviews`                                | ✓    | ✓    | Submit content → `202`           |
| `GET /api/v1/reviews`                                 | ✓    |      | List own reviews (paged, filter) |
| `GET /api/v1/reviews/:reviewId`                       | ✓    |      | Review with content and findings |
| `GET /api/v1/reviews/:reviewId/events`                | ✓    |      | SSE progress + findings          |
| `PATCH /api/v1/reviews/:reviewId/findings/:findingId` | ✓    | ✓    | Accept / dismiss a finding       |
| `DELETE /api/v1/reviews/:reviewId`                    | ✓    | ✓    | Delete review and its data       |
| `GET /health/live`, `GET /health/ready`               |      |      | Liveness / readiness             |

### Authentication and CSRF flow

1. `GET /api/v1/auth/csrf` → `{ csrfToken }` (sets HttpOnly CSRF + anonymous cookies).
2. `POST /auth/register` or `/auth/login` with header `X-CSRF-Token` → sets the HttpOnly
   session cookie and returns `{ user, csrfToken }`. **Replace** the stored token: tokens are
   bound to the session.
3. Send `X-CSRF-Token` on every `POST`/`PATCH`/`DELETE`; send all requests with credentials.
4. `POST /auth/logout` revokes the session server-side; fetch a new CSRF token afterwards.

### SSE

`GET /api/v1/reviews/:id/events` (with `withCredentials: true`) emits `review.started`,
`review.progress`, `finding.detected`, `review.completed`, `review.failed`. Every event has an
increasing numeric `id`; events are persisted, so reconnecting with `Last-Event-ID` (automatic
in browsers) or `?lastEventId=` replays what was missed. The stream closes after a terminal
event; a reconnect after that receives `204`, which stops `EventSource` retries. Clients should
close the `EventSource` on a terminal event and treat `GET /reviews/:id` as the authoritative
snapshot.

### Try it with curl (mock mode)

```bash
B=http://localhost:3000/api/v1; O='Origin: http://localhost:4200'; J='Content-Type: application/json'
T=$(curl -s -c jar -b jar $B/auth/csrf | jq -r .csrfToken)
T=$(curl -s -c jar -b jar -H "$O" -H "$J" -H "X-CSRF-Token: $T" \
  -d '{"email":"me@example.com","password":"correct horse battery","displayName":"Me"}' \
  $B/auth/register | jq -r .csrfToken)
ID=$(curl -s -b jar -H "$O" -H "$J" -H "X-CSRF-Token: $T" \
  -d '{"documentTitle":"Report","content":"The report have several mistake.","categories":["grammar","spelling"]}' \
  $B/reviews | jq -r .reviewId)
curl -N -b jar $B/reviews/$ID/events          # streams events, ends at review.completed
curl -s -b jar $B/reviews/$ID | jq .review.findings
F=$(curl -s -b jar $B/reviews/$ID | jq -r '.review.findings[0].findingId')
curl -s -b jar -H "$O" -H "$J" -H "X-CSRF-Token: $T" -X PATCH -d '{"status":"accepted"}' \
  $B/reviews/$ID/findings/$F | jq
curl -s -b jar -c jar -H "$O" -H "X-CSRF-Token: $T" -X POST $B/auth/logout -o /dev/null -w '%{http_code}\n'
```

## Testing

```bash
npm test
```

- Integration tests run against an in-memory MongoDB (`mongodb-memory-server`, downloaded on
  first run) and a **mock** Python client; Python HTTP client tests use a local stub HTTP
  server. No OpenAI key or Python service is needed.
- Coverage: auth/session revocation, CSRF binding and origin checks, ownership on every review
  endpoint, validation and limits, finding transitions, processing lifecycle, retries and
  backoff, permanent failures, crash/lease recovery, stale-worker protection, duplicate
  delivery, shutdown release, SSE ordering/replay/`Last-Event-ID`/204/cleanup, Python client
  error mapping and timeouts, Unicode/emoji offsets, env validation.

## Docker

```bash
docker compose up --build                          # MongoDB + API (mock LLM by default)
PYTHON_LLM_MODE=http PYTHON_LLM_SERVICE_TOKEN=... docker compose up --build   # real Python service on the host
docker compose --profile worker up --build         # add a dedicated worker container
```

The image is multi-stage, runs as the non-root `node` user, contains only production
dependencies, and has a liveness `HEALTHCHECK`. Compose binds ports to `127.0.0.1` and uses
development-only secrets; never use them in production.

## Observability

**Logging** uses [Pino](https://getpino.io): structured JSON on stdout, one line per HTTP request
(method, route path, status, latency; `/health` excluded) plus application events. Every line
written during a request or job automatically carries its correlation ids (`requestId`,
`userId`, `reviewId`, `jobId`, `attempt`) via `AsyncLocalStorage`. Responses return
`X-Request-Id`, and error bodies include `error.requestId`, so a user-reported error can be
traced to its log lines. Passwords, cookies, tokens, CSRF tokens and document content are never
logged. Use `LOG_FORMAT=pretty` locally for readable, colorized output (JSON is enforced in
production).

**Metrics** are exposed in Prometheus format on a separate internal port
(`http://<host>:9464/metrics`, configurable via `METRICS_PORT`; never on the public API port):
request rate/latency/errors by route template, review job outcomes and durations, queue depth,
Python LLM call outcomes and latency, open SSE streams, and Node.js process metrics (CPU, memory,
GC, event-loop lag).

**Dashboard** (local): Grafana + Prometheus + Loki + Grafana Alloy run as a compose profile.

```bash
docker compose --profile observability up --build
# add --profile worker to also run (and scrape) the dedicated worker
```

| URL                           | What                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| http://localhost:3001         | Grafana (admin / `$GRAFANA_ADMIN_PASSWORD`, default `admin`) → "Content Review Service" dashboard |
| http://localhost:9090/targets | Prometheus scrape targets                                                                         |

To find everything about one request, paste its `X-Request-Id` (or a `reviewId`) into the
dashboard's **Search logs** box, or use Explore → Loki:
`{service="content-review-service"} | json | requestId="<id>"`.

In production, point your platform's log agent at container stdout and have Prometheus (or a
compatible agent such as Grafana Alloy / Datadog / CloudWatch) scrape port 9464; the dashboard
JSON in `observability/grafana/dashboards/` can be imported into any Grafana.

## Deployment and security checklist

- `NODE_ENV=production` enforces: `AUTH_COOKIE_SECURE=true`, https-only `FRONTEND_ORIGIN`,
  non-placeholder secrets, distinct JWT/CSRF secrets, `PYTHON_LLM_MODE=http`.
- Load secrets (`AUTH_JWT_SECRET`, `CSRF_SECRET`, `PYTHON_LLM_SERVICE_TOKEN`, MongoDB
  credentials) from a secret manager. Rotating `AUTH_JWT_SECRET` logs everyone out.
- Terminate TLS at a proxy and set `TRUST_PROXY` (e.g. `1`) so rate limiting sees client IPs.
- Serve UI and API from the same site (keep `SameSite=Lax`), or use `SameSite=None; Secure` for
  cross-site deployments. Prefer a `__Host-` prefixed CSRF cookie name over HTTPS.
- Proxies must not buffer `text/event-stream` (we send `X-Accel-Buffering: no`) and must allow
  long-lived responses; heartbeats are sent every 15 s.
- Keep the Python service on a private network; never route it through the public gateway.
- Use a MongoDB user with least privilege, TLS, and backups. TTL indexes enforce retention
  (`REVIEW_RETENTION_DAYS`).
- With multiple API instances, use a shared rate-limit store or gateway limits; run workers in
  any number of instances or as a separate deployment (`WORKER_ENABLED=false` on API pods).
- Point orchestrator probes at `/health/live` and `/health/ready`; `SIGTERM` drains HTTP, SSE
  and in-flight jobs within `SHUTDOWN_GRACE_MS`.
- Logs exclude passwords, cookies, tokens, CSRF tokens, document content and finding text.
- Keep the metrics port (`METRICS_PORT`) private to your monitoring network; do not route it
  through the public load balancer. Change the Grafana admin password for any shared setup.
