# ContentReviewService — Public API Contract (v1)

This document is the **source of truth** for the Angular (`ContentReviewUI`) ↔ Node.js API.
Anything not documented here is an implementation detail and may change.

- Base path: `/api/v1`
- Content type: `application/json; charset=utf-8` (requests and responses), except SSE.
- Timestamps: ISO-8601 UTC strings, e.g. `2026-10-04T00:00:00.000Z`.
- IDs: `reviewId` is a 24-char lowercase hex string; `findingId` matches `^fnd_[a-f0-9]{24}$`.
- Unknown request body fields are **rejected** (`400 VALIDATION_FAILED`). Clients must ignore
  unknown **response** fields (we may add fields without a version bump).

## Contents

1. [Authentication and CSRF](#1-authentication-and-csrf)
2. [Errors](#2-errors)
3. [Auth endpoints](#3-auth-endpoints)
4. [Review endpoints](#4-review-endpoints)
   - [Document endpoints](#document-endpoints)
5. [Server-Sent Events](#5-server-sent-events)
6. [Text offsets](#6-text-offsets)
7. [Schemas](#7-schemas)
8. [Limits](#8-limits)

---

## 1. Authentication and CSRF

### Session cookie

Logging in or registering sets an **HttpOnly** cookie (default name `content_review_session`)
containing a signed JWT. Browser JavaScript can never read it and it is never present in a
response body.

| Attribute  | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| `HttpOnly` | always                                                                 |
| `Secure`   | `true` in production (required by config validation)                   |
| `SameSite` | `Lax` by default (configurable `Strict`/`None`; `None` needs `Secure`) |
| `Path`     | `/api`                                                                 |
| `Max-Age`  | `AUTH_TOKEN_TTL` (default 15 minutes)                                  |

Sessions are also stored server-side: **logout revokes the session immediately**, even if the
old cookie is replayed. When the session expires, protected endpoints return
`401 AUTH_REQUIRED`; the UI should redirect to login.

All requests must be sent with credentials:

```ts
// Angular
this.http.get('/api/v1/auth/me', { withCredentials: true });
// SSE
new EventSource('/api/v1/reviews/<id>/events', { withCredentials: true });
```

### CSRF (signed double-submit token)

Every **state-changing** request (`POST`, `PATCH`, `PUT`, `DELETE`) — including `login` and
`register` — must send the header `X-CSRF-Token: <token>`.

1. On app start, call `GET /api/v1/auth/csrf` → `{ "csrfToken": "..." }`. This also sets an
   HttpOnly CSRF cookie (and, before login, an anonymous-identity cookie).
2. Keep the token **in memory** (a service field). Do not put it in localStorage.
3. Send it as `X-CSRF-Token` on every unsafe request (an `HttpInterceptor` is ideal).
4. **Tokens are bound to the session.** `login` and `register` responses contain a fresh
   `csrfToken`; replace the stored token with it. After `logout`, call `GET /auth/csrf` again.
5. On `403 CSRF_INVALID`, call `GET /auth/csrf` once and retry the request once.

Do **not** use Angular's built-in `HttpClientXsrfModule` cookie-reading mechanism: the CSRF
cookie is HttpOnly by design. Use the token from the JSON response.

### Origin checks and CORS

- Only origins listed in `FRONTEND_ORIGIN` receive CORS headers (`Access-Control-Allow-Credentials: true`).
- State-changing requests with an `Origin` (or, failing that, `Referer`) outside the allowlist
  are rejected with `403 ORIGIN_NOT_ALLOWED`.
- Allowed request headers: `Content-Type`, `X-CSRF-Token`, `X-Request-Id`, `Last-Event-ID`.
- Exposed response headers: `X-Request-Id`, `Location`, `RateLimit`, `RateLimit-Policy`, `Retry-After`.

### Correlation IDs

Every response has an `X-Request-Id` header. Clients may send their own `X-Request-Id`
(8–64 chars of `[A-Za-z0-9._-]`); otherwise one is generated. Error bodies repeat it as
`error.requestId` — show it in support/error UIs.

---

## 2. Errors

All errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "requestId": "3f0c8a7e-...",
    "details": [{ "path": "body.categories", "message": "At least one category is required" }]
  }
}
```

`details` is present only for `VALIDATION_FAILED`. `message` is safe to display but clients
should branch on `code`.

| HTTP | `code`                      | Meaning                                                       |
| ---- | --------------------------- | ------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`         | Body/params/query failed validation (see `details[].path`)    |
| 400  | `MALFORMED_JSON`            | Body is not valid JSON                                        |
| 401  | `AUTH_REQUIRED`             | No valid session (missing, expired, revoked)                  |
| 401  | `INVALID_CREDENTIALS`       | Login failed (same response for unknown email/wrong password) |
| 403  | `CSRF_INVALID`              | Missing/invalid `X-CSRF-Token`                                |
| 403  | `ORIGIN_NOT_ALLOWED`        | Request origin not in the allowlist                           |
| 404  | `NOT_FOUND`                 | Unknown route                                                 |
| 404  | `REVIEW_NOT_FOUND`          | Review does not exist **or belongs to another user**          |
| 404  | `FINDING_NOT_FOUND`         | Finding id not in this review                                 |
| 404  | `DOCUMENT_NOT_FOUND`        | Document does not exist **or belongs to another user**        |
| 409  | `DOCUMENT_VERSION_CONFLICT` | Document was saved elsewhere since the client loaded it       |
| 409  | `EMAIL_ALREADY_REGISTERED`  | Registration with an existing email                           |
| 409  | `REVIEW_NOT_COMPLETED`      | Finding update before the review completed                    |
| 409  | `INVALID_STATE_TRANSITION`  | Finding status change not allowed                             |
| 409  | `CONFLICT`                  | Concurrent modification; reload and retry                     |
| 413  | `PAYLOAD_TOO_LARGE`         | Body exceeds `BODY_LIMIT`                                     |
| 415  | `UNSUPPORTED_MEDIA_TYPE`    | Unsupported request encoding                                  |
| 429  | `RATE_LIMITED`              | Too many requests; honor `RateLimit`/`Retry-After` headers    |
| 500  | `INTERNAL_ERROR`            | Unexpected server error                                       |

Review **processing** failures are not HTTP errors; they appear as `status: "failed"` with
`errorCode`/`errorMessage` on the review and in the `review.failed` SSE event:

| `errorCode`                | Meaning (user-safe `errorMessage` is provided)    |
| -------------------------- | ------------------------------------------------- |
| `LLM_SERVICE_UNAVAILABLE`  | Analysis service unavailable after retries        |
| `LLM_SERVICE_TIMEOUT`      | Analysis timed out after retries                  |
| `LLM_SERVICE_RATE_LIMITED` | Analysis service busy after retries               |
| `LLM_INVALID_RESPONSE`     | Analysis service returned invalid results         |
| `LLM_REQUEST_REJECTED`     | Content could not be reviewed (not retried)       |
| `LLM_CONTENT_TOO_LARGE`    | Content too long for the analysis service         |
| `PROCESSING_TIMEOUT`       | Processing did not finish (e.g. repeated crashes) |
| `PROCESSING_FAILED`        | Unexpected processing failure                     |

---

## 3. Auth endpoints

### `GET /auth/csrf`

Response `200`: `{ "csrfToken": "string" }` (header `Cache-Control: no-store`).

### `POST /auth/register` _(CSRF)_

```json
{ "email": "alice@example.com", "password": "at least 12 chars", "displayName": "Alice" }
```

| Field         | Rules                                                   |
| ------------- | ------------------------------------------------------- |
| `email`       | valid email, ≤ 254 chars; trimmed and stored lower-case |
| `password`    | 12 characters minimum, ≤ 72 UTF-8 bytes                 |
| `displayName` | 1–100 chars after trimming                              |

Response `201`: `{ "user": User, "csrfToken": "string" }` + session cookie.
Errors: `400`, `403`, `409 EMAIL_ALREADY_REGISTERED`, `429`.

### `POST /auth/login` _(CSRF)_

`{ "email": "...", "password": "..." }` → `200 { "user": User, "csrfToken": "string" }` + cookie.
Errors: `401 INVALID_CREDENTIALS` (generic), `400`, `403`, `429`.

### `POST /auth/logout` _(auth, CSRF)_

`204 No Content`. Revokes the session and clears the session and CSRF cookies.

### `GET /auth/me` _(auth)_

`200 { "user": User }`.

---

## 4. Review endpoints

All review endpoints require authentication. Every query is scoped to the current user;
another user's review is reported as `404 REVIEW_NOT_FOUND`.

### `POST /reviews` _(CSRF)_

```json
{
  "documentTitle": "Quarterly Business Report",
  "content": "The report have several mistake.",
  "categories": ["grammar", "spelling"]
}
```

| Field           | Rules                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentTitle` | 1–200 chars after trimming                                                                                                                                                  |
| `content`       | not blank; ≤ `REVIEW_MAX_CONTENT_CHARS` **code points** (default 50 000); well-formed Unicode. Stored **exactly as sent** (no trimming/normalization) so offsets stay valid |
| `categories`    | **optional**, informational: non-empty, unique list of `Category` values. Stored and echoed back, but every issue type is always checked                                    |

Response `202 Accepted` (returns immediately; analysis runs in the background), header
`Location: /api/v1/reviews/{reviewId}`:

```json
{
  "reviewId": "6720f1c2a4b5c6d7e8f90123",
  "status": "pending",
  "eventsUrl": "/api/v1/reviews/6720f1c2a4b5c6d7e8f90123/events",
  "createdAt": "2026-10-04T00:00:00.000Z"
}
```

### `GET /reviews?page=1&limit=20&status=completed`

| Query    | Default | Rules                                                                 |
| -------- | ------- | --------------------------------------------------------------------- |
| `page`   | 1       | integer ≥ 1                                                           |
| `limit`  | 20      | integer 1–50                                                          |
| `status` | —       | optional: `pending`, `processing`, `completed`, `failed`, `cancelled` |

Newest first. Response `200`:

```json
{ "items": [ReviewSummary], "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
```

### `GET /reviews/{reviewId}`

`200 { "review": Review }` — includes `content` and all `findings`. Use this to restore state
after a refresh or reconnect. `400` for a malformed id, `404` if not found/not owned.

### `PATCH /reviews/{reviewId}/findings/{findingId}` _(CSRF)_

```json
{ "status": "accepted" }
```

`status` ∈ `accepted` | `dismissed`. Allowed transitions:

| From        | To                      |
| ----------- | ----------------------- |
| `pending`   | `accepted`, `dismissed` |
| `accepted`  | `dismissed`             |
| `dismissed` | `accepted`              |
| `resolved`  | — (system-managed)      |

Setting the current status again is a no-op that returns `200`. Response `200 { "finding": Finding }`.
Errors: `409 REVIEW_NOT_COMPLETED`, `409 INVALID_STATE_TRANSITION`, `409 CONFLICT`,
`404 REVIEW_NOT_FOUND`, `404 FINDING_NOT_FOUND`.

### `DELETE /reviews/{reviewId}` _(CSRF)_

`204`. Permanently deletes the review, its content, findings and event history. Any in-flight
processing stops writing.

### `GET /reviews/{reviewId}/events`

Server-Sent Events. See below.

---

## Document endpoints

An author's working document: the text they write and edit, saved independently of reviews
(a review still stores its own snapshot of the content it analysed). All endpoints require
authentication and are scoped to the current user; another user's document is reported as
`404 DOCUMENT_NOT_FOUND`.

**Content is stored exactly as sent.** Indentation, tabs, blank lines, trailing spaces, line
endings (`\n` and `\r\n`) and Unicode are never trimmed, normalized or converted, so `GET` returns
the identical string. Only `title` is trimmed.

| Field     | Rules                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `title`   | 1–200 chars after trimming, well-formed Unicode                                                            |
| `content` | string, may be empty; ≤ `DOCUMENT_MAX_CONTENT_CHARS` **code points** (default 50 000); well-formed Unicode |
| `version` | (`PUT` only) the version the client last loaded; integer ≥ 1                                               |

### `POST /documents` _(CSRF)_

```json
{ "title": "Quarterly Business Report", "content": "  Indented line\n\tTabbed line\n" }
```

`201 { "document": Document }`, header `Location: /api/v1/documents/{documentId}`.

### `GET /documents?page=1&limit=20`

Most recently updated first. `200 { "items": [DocumentSummary], "page", "limit", "total", "totalPages" }`.
Summaries omit `content`.

### `GET /documents/{documentId}`

`200 { "document": Document }`. `400` for a malformed id, `404 DOCUMENT_NOT_FOUND`.

### `PUT /documents/{documentId}` _(CSRF)_

```json
{ "title": "Quarterly Business Report", "content": "…", "version": 3 }
```

Replaces `title` and `content` only if `version` is still current, then increments `version`.
`200 { "document": Document }`. If someone saved in the meantime (another tab or device):
`409 DOCUMENT_VERSION_CONFLICT` and nothing is written; reload, then save again.

### `DELETE /documents/{documentId}` _(CSRF)_

`204`.

```ts
interface DocumentSummary {
  documentId: string;
  title: string;
  contentLength: number; // code points
  version: number; // starts at 1, +1 per update
  createdAt: string;
  updatedAt: string;
}
interface Document extends DocumentSummary {
  content: string; // exactly as saved
}
```

---

## 5. Server-Sent Events

`GET /api/v1/reviews/{reviewId}/events` (auth required; cookie sent via `withCredentials`).

Authorization and ownership are checked **before** the stream opens, so failures are ordinary
JSON errors (`401`, `404`, `400`).

### Response

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-store, no-transform
X-Accel-Buffering: no

retry: 3000

id: 1
event: review.started
data: {"reviewId":"...","status":"processing","occurredAt":"..."}

: heartbeat
```

- `id` is a positive integer, strictly increasing **per review**. Ids may have gaps.
- A `: heartbeat` comment is sent every `SSE_HEARTBEAT_MS` (default 15 s).
- The server **closes the stream after `review.completed` or `review.failed`**. The client must
  then call `eventSource.close()` (otherwise the browser auto-reconnects; see 204 below).
- If the review is deleted while connected, the stream closes.

### Events

All payloads include `reviewId` and `occurredAt`.

| `event`            | `data`                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review.started`   | `{ reviewId, status: "processing", occurredAt }` — emitted once                                                                                                  |
| `review.progress`  | `{ reviewId, stage, attempt, nextAttemptAt?, occurredAt }` — `stage` ∈ `analyzing`, `validating`, `persisting`, `retrying` (`nextAttemptAt` only for `retrying`) |
| `finding.detected` | `{ reviewId, finding: Finding, occurredAt }` — one per finding, ordered by offset                                                                                |
| `review.completed` | `{ reviewId, status: "completed", findingCount, completedAt, occurredAt }` — terminal                                                                            |
| `review.failed`    | `{ reviewId, status: "failed", errorCode, errorMessage, occurredAt }` — terminal                                                                                 |

Typical sequence: `review.started` → `review.progress(analyzing)` → (`review.progress(retrying)`
→ `review.progress(analyzing)`)\* → `review.progress(validating)` → `review.progress(persisting)` →
`finding.detected`\* → `review.completed`.

`finding.detected` events are emitted **after** all findings are validated and persisted —
this is not token-by-token LLM streaming.

### Reconnection and recovery

- Events are persisted. Any connection **replays every event after the last id it has seen**
  and then continues live.
- On automatic reconnect, the browser sends `Last-Event-ID`; the server resumes after it.
- After a full page reload, open `.../events?lastEventId=<n>` to resume, or omit it to replay
  from the beginning. The `Last-Event-ID` header takes precedence over the query parameter.
- If the review is already terminal and there is nothing after the given id, the server
  responds **`204 No Content`**, which tells `EventSource` to stop reconnecting.
- Delivery is **at-least-once**: deduplicate by event `id` (and findings by `findingId`).
- Recommended UI flow: `GET /reviews/{id}` for the current snapshot, then subscribe to events
  only if `status` is `pending` or `processing`, merging findings by `findingId`.

```ts
const es = new EventSource(`/api/v1/reviews/${id}/events`, { withCredentials: true });
es.addEventListener('finding.detected', (e) => upsert(JSON.parse(e.data).finding));
es.addEventListener('review.completed', () => es.close());
es.addEventListener('review.failed', (e) => {
  showError(JSON.parse(e.data));
  es.close();
});
es.onerror = () => {
  /* the browser retries automatically; refresh via GET on repeated errors */
};
```

---

## 6. Text offsets

`startOffset` and `endOffset` are **Unicode code point** indexes into the review `content`,
forming a **half-open range `[startOffset, endOffset)`**.

- This equals Python's `content[start:end]`.
- In TypeScript use code-point arrays, **not** `String.prototype.slice` (UTF-16):

```ts
const cps = Array.from(content); // code points
const text = cps.slice(start, end).join(''); // === finding.originalText
// UTF-16 index for DOM ranges / string APIs:
const utf16Start = cps.slice(0, start).join('').length;
```

| Content                | Code points | `"wrld"` offsets | Note                               |
| ---------------------- | ----------- | ---------------- | ---------------------------------- |
| `Hi wrld`              | 7           | `[3, 7)`         | ASCII                              |
| `Hi 😀 wrld`           | 9           | `[5, 9)`         | 😀 = 1 code point (2 UTF-16 units) |
| `Hi 👋🏽 wrld`           | 10          | `[6, 10)`        | emoji + skin-tone modifier = 2     |
| `Hé wrld` (e + U+0301) | 8           | `[4, 8)`         | combining marks count separately   |

The server guarantees that, for every persisted finding,
`Array.from(content).slice(startOffset, endOffset).join('') === originalText`.
Content is never normalized, so these offsets always refer to the text exactly as submitted.

---

## 7. Schemas

### User

```ts
interface User {
  id: string;
  email: string; // lower-case
  displayName: string;
  createdAt: string;
}
```

### ReviewSummary

```ts
type ReviewStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
type Category =
  | 'spelling'
  | 'grammar'
  | 'typo'
  | 'punctuation'
  | 'clarity'
  | 'slang'
  | 'vulgarity'
  | 'deprecated_term'
  | 'inappropriate_language'
  | 'profanity'; // only on reviews created before the AI service v2; new findings never use it

interface ReviewSummary {
  reviewId: string;
  documentTitle: string;
  status: ReviewStatus;
  categories: Category[]; // [] when the client sent none
  findingCount: number; // 0 until completed
  errorCode: string | null; // set when status === 'failed'
  errorMessage: string | null; // user-safe
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

### Review

```ts
interface Review extends ReviewSummary {
  content: string;
  contentLength: number; // code points
  findings: Finding[]; // ordered by startOffset
  eventsUrl: string;
}
```

### Finding

```ts
interface Finding {
  findingId: string; // stable across retries and reconnects
  category: Category;
  severity: 'low' | 'medium' | 'high';
  originalText: string;
  suggestedText: string; // improved text; may be '' (e.g. remove a vulgarity)
  explanation: string; // what to change and why
  startOffset: number; // code points, inclusive
  endOffset: number; // code points, exclusive
  status: 'pending' | 'accepted' | 'dismissed' | 'resolved';
  createdAt: string;
  updatedAt: string;
}
```

Review status lifecycle: `pending → processing → completed | failed`. `cancelled` is reserved.

---

## 8. Limits

| Limit                     | Default                    | Config                                   |
| ------------------------- | -------------------------- | ---------------------------------------- |
| Request body              | 512 kB                     | `BODY_LIMIT`                             |
| Content length            | 50 000 code points         | `REVIEW_MAX_CONTENT_CHARS`               |
| Document length           | 50 000 code points         | `DOCUMENT_MAX_CONTENT_CHARS`             |
| API rate limit            | 300 req / 15 min / IP      | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Login/register rate limit | 20 req / 15 min / IP       | `AUTH_RATE_LIMIT_MAX`                    |
| Page size                 | 50                         | —                                        |
| Review retention          | 90 days, then auto-deleted | `REVIEW_RETENTION_DAYS`                  |
