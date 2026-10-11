# Python AI Service — Internal Integration Contract

This document describes the private HTTP contract between **ContentReviewService (Node.js)** and
the separately deployed **Python AI service**. The Python repository owns and implements this
contract; this file records what Node.js relies on.

- The Python service owns prompts, model calls, model selection and **its own** output validation.
- Node.js owns auth, persistence, orchestration, retries, SSE, and **independently re-validates**
  every response before persisting anything.
- The browser never calls the Python service. It must not be exposed publicly.

Node-side implementation: `src/integrations/python-llm/` (`llm.schemas.ts` is the executable
form of this contract) and `src/modules/reviews/issue-locator.ts` (placing issues in the text).

> **Revision 2.** The request no longer has `categories`, and the response returns `issues`
> anchored by surrounding text instead of `findings` with character offsets. The path is
> unchanged.

---

## 1. Transport and authentication

| Item     | Value                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL | `AI_SERVICE_BASE_URL` (e.g. `http://python-ai:8000`)                                                                                  |
| Protocol | HTTP/1.1, JSON (`Content-Type: application/json`)                                                                                     |
| Auth     | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` on **every** request                                                                 |
| Network  | Private network only (cluster-internal service / VPC). Use TLS (`https://`) whenever traffic leaves a trusted host or network segment |

The token is a shared secret provisioned to both services via a secret manager. Node.js never
logs it.

### Request headers sent by Node.js

| Header          | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `Authorization` | `Bearer <token>`                                                             |
| `X-Request-ID`  | Correlation id for logs (currently the review id). Log it; never log content |
| `Content-Type`  | `application/json`                                                           |
| `Accept`        | `application/json`                                                           |

---

> **Timeout budget.** Python caps one review at 45 s across all Gemini retries (25 s per call)
> and answers `504 LLM_PROVIDER_TIMEOUT` when it runs out. Node's `PYTHON_LLM_TIMEOUT_MS` (60 s)
> must stay larger, otherwise Node abandons a call that Python keeps running and burns provider
> quota. A timed-out review is retried once (`LlmTimeoutError.maxRetries = 1`), so the worst case
> before the author sees a failure is about 2 × 45 s plus backoff.

## 1b. `GET /internal/v1/content-reviews/models`

Same auth. Returns `{ "defaultModel": "...", "models": ["...", "..."] }`; `defaultModel` is
included in `models`. Node caches it for 5 minutes and validates the author's choice against it.

## 2. `POST /internal/v1/content-reviews`

Reviews the content and returns the complete list of issues in one (synchronous, LLM-backed)
response.

### Request

```json
{
  "requestId": "6720f1c2a4b5c6d7e8f90123",
  "content": "Please recieve the document.",
  "language": "en"
}
```

| Field       | Type   | Rules                                                                                      |
| ----------- | ------ | ------------------------------------------------------------------------------------------ |
| `requestId` | string | 1–128 chars. Node sends the review id. Echoed in the response                              |
| `content`   | string | 1–100 000 chars. Node sends the stored content exactly as submitted                        |
| `language`  | string | Optional, default `"en"`. Node currently omits it                                          |
| `model`     | string | Optional. Must be one of `GET .../models`; else `422 MODEL_NOT_ALLOWED`. Omitted = default |

**No other fields are allowed**: Python answers `422 INVALID_REQUEST` to unknown fields, so Node
sends exactly these. Every issue type is always checked; there is no category filter.

### Success response — `200 OK`

```json
{
  "requestId": "6720f1c2a4b5c6d7e8f90123",
  "issues": [
    {
      "id": "issue-3f9a1c2b7d10",
      "issueType": "spelling",
      "severity": "low",
      "original": "recieve",
      "improved": "receive",
      "suggestion": "Correct the spelling mistake.",
      "location": { "prefix": "Please ", "suffix": " the document." }
    }
  ],
  "model": "gemini-...",
  "usage": { "inputTokens": null, "outputTokens": null }
}
```

| Field       | Type    | Node.js validation                                 |
| ----------- | ------- | -------------------------------------------------- |
| `requestId` | string  | **Must equal** the request's `requestId`           |
| `issues`    | Issue[] | 0–1000 items, in document order. `[]` = no issues  |
| `model`     | string  | ≤ 200 chars, logged for diagnostics                |
| `usage`     | object  | `inputTokens`, `outputTokens`: integer ≥ 0 or null |

**Issue**

| Field             | Type   | Node.js validation                                                                                                                         |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | string | 1–200 chars, generated by Python (not stored; Node assigns its own stable `findingId`)                                                     |
| `issueType`       | enum   | `spelling` \| `grammar` \| `typo` \| `punctuation` \| `clarity` \| `slang` \| `vulgarity` \| `deprecated_term` \| `inappropriate_language` |
| `severity`        | enum   | `low` \| `medium` \| `high`                                                                                                                |
| `original`        | string | 1–10 000 chars; text found in `content`                                                                                                    |
| `improved`        | string | 0–10 000 chars (`""` allowed, e.g. "remove this word")                                                                                     |
| `suggestion`      | string | 1–2 000 chars, user-facing explanation                                                                                                     |
| `location.prefix` | string | 0–2 000 chars of text immediately before `original` (empty at the start of the content)                                                    |
| `location.suffix` | string | 0–2 000 chars of text immediately after `original` (empty at the end of the content)                                                       |

All strings must be well-formed Unicode (no lone surrogates). Unknown response fields are
ignored, so Python may add optional fields at any time.

### What Node.js does with the response

1. Validates the JSON against the schema above. **Any** violation (missing field, wrong type,
   unknown enum, `requestId` mismatch, size limits) rejects the whole response as
   `LLM_INVALID_RESPONSE` (retried once).
2. Places each issue in the stored content (`issue-locator.ts`): among the occurrences of
   `original`, it picks the one preceded by `prefix` and followed by `suffix`. Ties go to the
   first occurrence at or after the previous issue (issues are in document order). If no
   occurrence matches the context exactly, the one whose surroundings agree most is used and
   the issue is counted as approximate. Issues whose `original` is not in the content at all are
   dropped (Python already drops these, so it only happens if the content changed).
3. Converts the placement to **Unicode code point** offsets `[startOffset, endOffset)`, which the
   public API and the UI use for highlighting.
4. Maps fields to findings: `issueType` → `category`, `original` → `originalText`,
   `improved` → `suggestedText`, `suggestion` → `explanation`. Collapses duplicates (same
   category + range + text) and assigns stable `findingId`s.
5. Persists, then publishes SSE events. Logs only counts (placed, approximate, not found,
   duplicates), the model and token usage — never content or issue text.

---

## 3. Errors

Error responses use `{ "error": { "code", "message", "requestId" } }`. Node.js classifies by
HTTP status (and `code` where noted) and logs the code, never the message body.

| Status | `code`                | Node.js behavior                                                                                                                               | Review `errorCode`         |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 401    | `UNAUTHORIZED`        | Configuration bug: fail, **no retry**, log an error                                                                                            | `LLM_REQUEST_REJECTED`     |
| 413    | `CONTENT_TOO_LARGE`   | Fail, no retry ("shorten the content")                                                                                                         | `LLM_CONTENT_TOO_LARGE`    |
| 422    | `INVALID_REQUEST`     | Bug in our payload: fail, no retry                                                                                                             | `LLM_REQUEST_REJECTED`     |
| 429    | `LLM_QUOTA_EXHAUSTED` | Wait ≤ 5 min: back off (honoring `Retry-After`) within `JOB_MAX_ATTEMPTS`. Longer (daily quota): fail at once, surfacing `message` + `details` | `LLM_SERVICE_RATE_LIMITED` |
| 422    | `MODEL_NOT_ALLOWED`   | Do not retry (Node validates the model first, so this means a stale list)                                                                      | `LLM_REQUEST_REJECTED`     |

A 429 body carries `details` and a `Retry-After` header:

```json
{
  "error": {
    "code": "LLM_QUOTA_EXHAUSTED",
    "message": "The daily quota for model gemini-3.6-flash is exhausted. It resets in about 1h 58m. Try again later or choose a different model.",
    "requestId": "…",
    "details": {
      "model": "gemini-3.6-flash",
      "quotaScope": "daily",
      "retryAfterSeconds": 7105,
      "resetAt": "2026-10-11T05:30:00+00:00"
    }
  }
}
```

| 502 | `INVALID_MODEL_OUTPUT` | Retry **once** | `LLM_INVALID_RESPONSE` |
| 503 | `LLM_PROVIDER_UNAVAILABLE`, `AI_CONCURRENCY_LIMIT` | Retry with backoff, **at most 2** retries | `LLM_SERVICE_UNAVAILABLE` |
| 408/504 | any | Retry with backoff within `JOB_MAX_ATTEMPTS` | `LLM_SERVICE_TIMEOUT` |
| other 4xx | any | Fail, no retry | `LLM_REQUEST_REJECTED` |
| other 5xx | any | Retry with backoff within `JOB_MAX_ATTEMPTS` | `LLM_SERVICE_UNAVAILABLE` |

Network failures (refused, reset, DNS) and timeouts are retried with backoff within
`JOB_MAX_ATTEMPTS`.

---

## 4. Timeouts and retries

| Setting                 | Default                             | Notes                                         |
| ----------------------- | ----------------------------------- | --------------------------------------------- |
| Connect timeout         | 5 s                                 | `PYTHON_LLM_CONNECT_TIMEOUT_MS`               |
| Total request timeout   | 60 s                                | `PYTHON_LLM_TIMEOUT_MS` (headers + body)      |
| Max attempts per review | 4                                   | `JOB_MAX_ATTEMPTS`                            |
| Backoff                 | 2 s → 60 s, exponential with jitter | `JOB_BACKOFF_BASE_MS`, `JOB_BACKOFF_MAX_MS`   |
| Max response body       | 5 MB                                | Larger responses are rejected                 |
| Max content             | 50 000 code points                  | `REVIEW_MAX_CONTENT_CHARS`, must be ≤ 100 000 |

- Retries are durable: a failed attempt is rescheduled in the MongoDB job queue (surviving
  restarts) and the UI sees a `review.progress` event with stage `retrying`. Error-specific
  limits (once for 502, twice for 503) apply on top of `JOB_MAX_ATTEMPTS`.
- Node may send the **same `requestId` more than once** (retries, worker crash recovery).
  Node deduplicates findings regardless.

---

## 5. `GET /internal/v1/health`

Requires the same bearer token. A `2xx` within 3 s is reported as `pythonLlm: "ok"` in Node's
`/health/ready`; anything else as `"unavailable"`, which degrades but does not fail readiness
(reviews are queued durably and retried). Disable with `PYTHON_LLM_HEALTH_CHECK=false`.

---

## 6. Security and data handling

- Node never logs `INTERNAL_SERVICE_TOKEN`, `content`, or issue text (`original`, `improved`,
  `suggestion`, `prefix`, `suffix`). It logs the correlation id, timings, counts, model, token
  usage and error codes.
- Model provider API keys live **only** in the Python service.
