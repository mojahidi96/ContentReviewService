# Python LLM Service — Internal Integration Contract (v1)

This document defines the private HTTP contract between **ContentReviewService (Node.js)** and
the separately deployed **Python LLM service** (FastAPI). The Python repository implements
this contract; Node.js depends only on what is written here.

- The Python service owns prompts, OpenAI calls, model selection and **its own** output validation.
- Node.js owns auth, persistence, orchestration, retries, SSE, and **independently re-validates**
  every response before persisting anything.
- The browser never calls the Python service. It must not be exposed publicly.

Node-side implementation: `src/integrations/python-llm/` (`llm.schemas.ts` is the executable
form of this contract).

---

## 1. Transport and authentication

| Item     | Value                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL | `PYTHON_LLM_SERVICE_URL` (e.g. `http://python-llm:8000`)                                                                              |
| Protocol | HTTP/1.1, JSON (`Content-Type: application/json; charset=utf-8`)                                                                      |
| Auth     | `Authorization: Bearer <PYTHON_LLM_SERVICE_TOKEN>` on **every** request                                                               |
| Network  | Private network only (cluster-internal service / VPC). Use TLS (`https://`) whenever traffic leaves a trusted host or network segment |

The Python service **must** reject missing/invalid tokens with `401` (compare in constant time).
The token is a shared secret provisioned to both services via a secret manager; rotate by
accepting two tokens on the Python side during the rollover window. mTLS or signed service
identities (e.g. a service mesh) are drop-in upgrades and do not change this contract.

### Request headers sent by Node.js

| Header            | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `Authorization`   | `Bearer <token>`                                                             |
| `Idempotency-Key` | Equals `requestId` (the review id). Same key ⇒ same logical request          |
| `X-Request-Id`    | Correlation id for logs (currently the review id). Log it; never log content |
| `Content-Type`    | `application/json`                                                           |
| `Accept`          | `application/json`                                                           |

---

## 2. `POST /internal/v1/content-reviews`

Analyze content and return **the complete, validated** list of findings in one response.

### Request

```json
{
  "requestId": "6720f1c2a4b5c6d7e8f90123",
  "content": "The report have several mistake.",
  "categories": ["grammar", "spelling", "profanity"],
  "language": "en"
}
```

| Field        | Type     | Rules                                                                                                                                             |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`  | string   | Opaque, stable per review. Must be echoed in the response                                                                                         |
| `content`    | string   | 1–50 000 Unicode code points (Node enforces `REVIEW_MAX_CONTENT_CHARS`). Well-formed UTF-8. Do **not** trim or normalize before computing offsets |
| `categories` | string[] | Non-empty unique subset of `grammar`, `spelling`, `profanity`. Only return findings in these categories                                           |
| `language`   | string   | BCP-47 language tag. Currently always `"en"`                                                                                                      |

Python must ignore unknown request fields (Node may add optional fields in v1).

### Success response — `200 OK`

```json
{
  "requestId": "6720f1c2a4b5c6d7e8f90123",
  "offsetUnit": "codepoint",
  "model": "gpt-4.1-mini-2026-xx-xx",
  "findings": [
    {
      "category": "grammar",
      "severity": "medium",
      "originalText": "report have",
      "suggestedText": "report has",
      "explanation": "The verb should agree with a singular subject.",
      "startOffset": 4,
      "endOffset": 15
    },
    {
      "category": "grammar",
      "severity": "medium",
      "originalText": "several mistake",
      "suggestedText": "several mistakes",
      "explanation": "A plural quantifier requires a plural noun.",
      "startOffset": 16,
      "endOffset": 31
    }
  ]
}
```

| Field        | Type          | Rules                                                    |
| ------------ | ------------- | -------------------------------------------------------- |
| `requestId`  | string        | **Must equal** the request's `requestId`                 |
| `offsetUnit` | `"codepoint"` | Literal. Guards against offset-convention mismatches     |
| `model`      | string?       | Optional, ≤ 200 chars. Model identifier, for diagnostics |
| `findings`   | Finding[]     | 0–1000 items. An empty array means "no issues"           |

**Finding**

| Field           | Type    | Rules                                                                 |
| --------------- | ------- | --------------------------------------------------------------------- |
| `category`      | enum    | `grammar` \| `spelling` \| `profanity` (must be one of the requested) |
| `severity`      | enum    | `low` \| `medium` \| `high`                                           |
| `originalText`  | string  | 1–10 000 chars; **exactly** `content[startOffset:endOffset]`          |
| `suggestedText` | string  | 0–10 000 chars (`""` allowed, e.g. "remove this word")                |
| `explanation`   | string  | 1–2 000 chars, user-facing, plain text (no HTML/Markdown)             |
| `startOffset`   | integer | ≥ 0, code points, inclusive                                           |
| `endOffset`     | integer | > `startOffset`, ≤ `len(content)`, code points, exclusive             |

All strings must be well-formed Unicode (no lone surrogates).

### Offset semantics (critical)

Offsets are **Unicode code point indexes** with half-open ranges — exactly Python `str` indexing:

```python
assert content[f.start_offset:f.end_offset] == f.original_text
```

Do **not** use UTF-8 byte offsets, UTF-16 offsets, or grapheme-cluster indexes. LLMs are bad at
counting characters: the Python service should locate `originalText` in `content` itself (e.g.
search near the model's suggested position) and compute offsets programmatically, dropping
findings it cannot anchor.

| `content`       | `len()` | `"wrld"` → `[start, end)` |
| --------------- | ------- | ------------------------- |
| `"Hi wrld"`     | 7       | `[3, 7)`                  |
| `"Hi 😀 wrld"`  | 9       | `[5, 9)`                  |
| `"Hi 👋🏽 wrld"`  | 10      | `[6, 10)`                 |
| `"日本語 wrld"` | 8       | `[4, 8)`                  |

### What Node.js does with the response

1. Validates the JSON against the schema above. **Any** violation (missing field, wrong type,
   unknown enum, `offsetUnit` ≠ `codepoint`, `requestId` mismatch, size limits) rejects the
   whole response as `LLM_INVALID_RESPONSE`.
2. For each finding, verifies the category was requested and that the offsets reference
   exactly `originalText`. Findings failing these checks are **dropped individually** (counted
   in logs), and the rest are kept.
3. Collapses duplicates (same category + range + text) and assigns stable `findingId`s.
4. Persists, then publishes SSE events.

Unknown **response** fields are ignored, so Python may add optional fields at any time.

---

## 3. Errors

Error responses use:

```json
{ "error": { "code": "UPSTREAM_TIMEOUT", "message": "Human-readable, no content" } }
```

`message` must never contain the submitted content or prompts. Node.js classifies by HTTP
status; `code` is logged for diagnostics.

| Status      | Suggested `code`                                                 | Node.js behavior                                    |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| 400         | `INVALID_REQUEST`                                                | Fail review, **no retry**                           |
| 401/403     | `UNAUTHORIZED`                                                   | Fail review, no retry (configuration error — alert) |
| 413         | `CONTENT_TOO_LARGE`                                              | Fail review, no retry                               |
| 422         | `UNSUPPORTED_LANGUAGE`, `VALIDATION_ERROR`                       | Fail review, no retry                               |
| 408/504     | `UPSTREAM_TIMEOUT`                                               | Retry with backoff                                  |
| 429         | `RATE_LIMITED`                                                   | Retry, waiting at least `Retry-After`               |
| 500/502/503 | `INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`, `MODEL_OUTPUT_INVALID` | Retry with backoff (`Retry-After` honored if sent)  |

Use `429` (with `Retry-After: <seconds>`) when OpenAI rate-limits you or your own concurrency
limit is reached. If the model returns output that fails your validation after your own
internal attempts, respond `502 MODEL_OUTPUT_INVALID` rather than returning partial garbage.

A `200` whose body is not valid JSON or violates the schema is treated as retryable
`LLM_INVALID_RESPONSE`.

---

## 4. Timeouts, retries and idempotency

| Setting                 | Default                             | Notes                                       |
| ----------------------- | ----------------------------------- | ------------------------------------------- |
| Connect timeout         | 5 s                                 | `PYTHON_LLM_CONNECT_TIMEOUT_MS`             |
| Total request timeout   | 60 s                                | `PYTHON_LLM_TIMEOUT_MS` (headers + body)    |
| Max attempts per review | 4                                   | `JOB_MAX_ATTEMPTS`                          |
| Backoff                 | 2 s → 60 s, exponential with jitter | `JOB_BACKOFF_BASE_MS`, `JOB_BACKOFF_MAX_MS` |
| Max response body       | 5 MB                                | Larger responses are rejected               |

- Python should finish (or fail) **within the Node timeout**; set your OpenAI client timeout
  below it (e.g. 45 s for a 60 s Node timeout). Node aborts the HTTP request on timeout; Python
  should cancel the in-flight work when the client disconnects.
- Node may send the **same `requestId` more than once** (retries, worker crash recovery,
  duplicate delivery). Python must treat this as safe: either recompute, or cache by
  `Idempotency-Key` and return the stored result. Node deduplicates findings regardless.
- Node never retries `4xx` except `408` and `429`.

---

## 5. `GET /internal/v1/health`

Requires the same bearer token. Returns `200 {"status":"ok"}` when the service can accept
work (it should not call OpenAI on every health check). Any non-2xx or a 3 s timeout is
reported as `pythonLlm: "unavailable"` in Node's `/health/ready`, which degrades but does not
fail readiness (reviews are queued durably and retried).

---

## 6. Versioning and compatibility

- The version is in the path (`/internal/v1/...`). Breaking changes require `/internal/v2/`,
  deployed alongside v1 until Node migrates.
- **Non-breaking (allowed in v1):** new optional response fields; new optional request fields
  (Python must ignore unknown request fields); new error `code` values.
- **Breaking (requires v2):** removing/renaming fields; changing offset semantics; new
  `category` or `severity` values (Node would reject them); changing types or limits downward.
- Deploy order for v2: Python serves v1+v2 → Node switches to v2 → Python removes v1.

---

## 7. Future streaming endpoint (not implemented)

Node's client interface yields an async stream of chunks:
`{ type: "findings", findings } … { type: "result", findings, model }`. A future
`POST /internal/v1/content-reviews:stream` (e.g. NDJSON or SSE, one validated finding batch per
line, terminated by a final summary) can be adopted by adding a new client implementation; the
review domain does not change. Until then, Python returns the complete result in one response.

---

## 8. Security and data handling

- Do not log `content`, prompts, or model outputs at info level; log `X-Request-Id`, timings,
  token counts and error codes instead.
- Do not persist content beyond what is needed to serve the request (or the idempotency cache,
  with a short TTL).
- The OpenAI API key lives **only** in the Python service. Node.js never has it.
- Configure OpenAI data-retention settings according to your organization's policy.
