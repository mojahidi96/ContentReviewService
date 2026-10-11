# Prompt: model dropdown and quota-failure messages in the UI

Copy everything below the line into the UI repo's coding assistant.

---

Update this UI to support two new backend features. First inspect the existing code and match its
conventions (framework, API service/client layer, state management, styling, i18n, tests). The
backend is the Node.js API under `/api/v1`; it uses the session cookie plus the CSRF header
(`X-CSRF-Token`) the UI already uses for `POST /reviews`. Do not change backend code.

## Feature 1: author picks the AI model

Backend contract:

- `GET /api/v1/reviews/models` (authenticated) →
  `{ "defaultModel": "gemini-3.6-flash", "models": ["gemini-3.6-flash", "gemini-3.8-flash", ...] }`
  (`defaultModel` is always inside `models`). Failure `503` means the list is unavailable.
- `POST /api/v1/reviews` now accepts an optional `"model": "<one of models>"`. Omit the field to
  use the default. An unknown value returns `400 VALIDATION_FAILED` with
  `error.details = [{ "path": "model", "message": "This model is not available." }]`.
- Review objects (`GET /reviews/{id}`, list items) now include `model: string | null`
  (`null` = the default model was used).

Build:

1. On the "new review" screen add a **Model** dropdown (select) next to the submit button.
   - Load the options from `GET /reviews/models` when the screen opens; show a loading state.
   - Preselect `defaultModel` and label it "(default)". Show the model ids as-is; a small
     mapping for friendlier names is fine but must fall back to the raw id.
   - Remember the last choice for the session (e.g. local storage), but only restore it if it is
     still in the returned list.
   - If the call fails (503/network), hide or disable the dropdown with a short note
     "Using the default model", and submit **without** `model`. Never block reviewing because the
     list failed to load.
2. Send the selected model as `model` in the create-review request. Send nothing when the
   default is selected or the list was unavailable.
3. Show which model produced a review on the review detail page and, if there is room, in the
   review list (`review.model ?? "Default model"`).
4. If create returns `400` with a `model` detail, refresh the model list, reset the selection to
   the default and show "That model is no longer available. Please choose another."

## Feature 2: clear messages when a review fails (especially quota exhausted)

A review's outcome arrives through the existing SSE stream (`GET /reviews/{id}/events`, event
`review.failed`) or by reading the review. Both now carry:

```json
{
  "status": "failed",
  "errorCode": "LLM_SERVICE_RATE_LIMITED",
  "errorMessage": "The daily quota for model gemini-3.6-flash is exhausted. It resets in about 1h 58m. Try again later or choose a different model.",
  "errorDetails": {
    "model": "gemini-3.6-flash",
    "quotaScope": "daily",
    "retryAfterSeconds": 7105,
    "resetAt": "2026-10-11T05:30:00+00:00"
  }
}
```

- `errorMessage` is user-safe and ready to display. Always show it; never show raw
  `errorCode`s or stack traces to the author.
- `errorDetails` is non-null only for quota failures (`errorCode = LLM_SERVICE_RATE_LIMITED`).
  Every field inside may be `null`/missing. `quotaScope` is `"daily" | "minute" | "unknown"`.
  `resetAt` is an ISO-8601 UTC timestamp.
- Other `errorCode`s you may see on failed reviews: `LLM_SERVICE_UNAVAILABLE`,
  `LLM_SERVICE_TIMEOUT`, `LLM_INVALID_RESPONSE`, `LLM_CONTENT_TOO_LARGE`,
  `LLM_REQUEST_REJECTED`, `PROCESSING_TIMEOUT`, `PROCESSING_FAILED`. For these just show
  `errorMessage`.

Build:

1. A single failure banner/panel component used in both the live (SSE) view and the review detail
   page, so a refresh shows the same thing as the live event.
2. For `LLM_SERVICE_RATE_LIMITED` show:
   - the title "AI quota reached";
   - `errorMessage`;
   - the reset time in the **user's local time zone** ("Resets at 7:30 AM") when `resetAt` is
     present, plus a relative hint ("in about 2 hours"). If `resetAt` is missing but
     `retryAfterSeconds` exists, compute from now. If neither exists, show only the message;
   - when `errorDetails.model` is present and other models are available in the dropdown list,
     a **"Try another model"** action that scrolls/returns to the form with the model dropdown
     focused and the failed model excluded or marked "quota reached";
   - a **Retry** button that re-submits the same content. When `quotaScope` is `daily`, disable
     Retry until `resetAt` (show a live countdown or the time) because it cannot succeed sooner;
     for `minute` or `unknown` it may stay enabled.
3. Show transient progress honestly: the SSE `review.progress` event with `stage: "retrying"`
   means the backend is waiting before another attempt (`nextAttemptAt` is when) — show
   "Retrying…" rather than an error. Only `review.failed` is terminal.
4. Handle `review.failed` arriving with no `errorDetails` (older reviews): fall back to the plain
   `errorMessage`.

## Feature 3: never leave the user watching a spinner forever

Backend worst case for one review is about 2 minutes (45 s Python budget, one retry after a
timeout, plus queue and backoff). Build a watchdog in the review-progress view:

1. Show elapsed time while status is `pending`/`processing`, and a step label from the latest
   `review.progress` stage (`analyzing`, `validating`, `persisting`, `retrying`).
2. After **30 s** without a terminal event, add "Still working… large documents and busy models
   can take up to 2 minutes."
3. After **150 s** with no terminal event, stop showing the spinner and show "This is taking
   longer than expected" with **Check status** (re-fetch `GET /reviews/{id}`) and **Cancel and
   retry** actions. Re-fetching should also happen automatically once, because a missed SSE
   event must not look like a hang.
4. If the SSE connection drops, rely on the browser's automatic reconnect (the server resends
   missed events using `Last-Event-ID`), and also poll `GET /reviews/{id}` every 5 s while the
   stream is down. Stop polling as soon as the status is `completed` or `failed`.
5. A failed review with `errorCode: "LLM_SERVICE_TIMEOUT"` shows its `errorMessage` plus a
   **Retry** button and "Try another model" (same as quota failures, but Retry is always enabled).
6. Disable the submit button while a review is being created to avoid duplicate submissions,
   and set a client-side request timeout of 30 s on `POST /reviews` (it returns 202 immediately).

## Tests

Unit/component tests with mocked HTTP and SSE (no real backend or AI calls):
dropdown loads and preselects the default; list failure falls back to default and omits `model`;
selected model is sent in the create request; `400` on `model` resets the selection; quota banner
renders message and local reset time; daily-quota Retry is disabled until `resetAt`, minute-quota
Retry is enabled; "Try another model" focuses the dropdown; non-quota failures show only
`errorMessage`; the review detail page shows the model.

Also test the watchdog with fake timers: 30 s hint, 150 s "taking longer" state, polling while SSE is down, and polling stops on a terminal status.
