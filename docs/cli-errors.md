# CLI Errors

`coral-cli` has a stable machine-readable error contract when `--output-format json` is selected. Errors are written to `stderr` as a single flat JSON object. Text-mode errors remain human-oriented and are not a stable parsing surface.

`wait` and follow-mode commands keep successful NDJSON events on `stdout`. Only failures move to `stderr`.

## Envelope

CLI errors use this shape:

```json
{
  "error": true,
  "code": "invalid_request",
  "message": "timeoutSeconds: Number must be less than or equal to 1200",
  "detail": {
    "issues": [
      {
        "code": "too_big",
        "path": ["timeoutSeconds"],
        "message": "Number must be less than or equal to 1200"
      }
    ]
  }
}
```

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `error` | `true` | Constant marker for error envelopes |
| `code` | string | Stable programmatic error code |
| `message` | string | Short human-readable summary |
| `detail` | unknown, optional | Extra structured detail. For backend schema validation this includes `detail.issues` from Zod |

Backend HTTP errors are lifted into the same flat CLI shape. There is no nested `body` wrapper in CLI JSON output.

When a backend HTTP response body is missing, non-JSON, or does not carry a `code`/`message` field, the CLI falls back to:

- `code`: `backend_error`
- `message`: the client-side HTTP status description (e.g. `HTTP 503 Service Unavailable`)

This only affects malformed or truncated backend responses. In normal operation every backend error path emits `{code, message}` and is surfaced unchanged.

## Code Catalog

| Code | Meaning |
| --- | --- |
| `invalid_usage` | CLI-side validation failure before the request is sent. Includes local flag parsing, local integer parsing, and Commander usage errors |
| `invalid_request` | Backend request/schema validation failure after the request reached the backend |
| `not_found` | Generic backend resource not found |
| `session_not_found` | Referenced session does not exist |
| `audit_requires_ended_session` | Audit/detail view was requested for a discuss session that has not ended yet |
| `scope_mismatch` | The requested resource exists, but not in the current project/scope |
| `unauthorized` | Backend token/auth mismatch |
| `transient` | Retryable HTTP failure surfaced by the client as a `TransientHttpError` instance, covering HTTP `502`/`503`/`504`. CLI-side: any `TransientHttpError` maps to exit `75` via `instanceof` dispatch; `code === 'transient'` or backend `503` bodies also land on exit `75` |
| `backend_shutting_down` | The backend is running but draining and refusing new work |
| `backend_unreachable` | The backend could not be reached at all. Typical causes are not-started daemon, refused connection, or transport-level lookup/reset failures |
| `backend_error` | Fallback for a backend error response that did not provide a recognized `code` |
| `internal` / `internal_error` | Unhandled CLI-side failure (`internal`) or backend `500` contract response (`internal_error`) |

## Exit Codes

| Exit | When used |
| --- | --- |
| `2` | `invalid_usage` |
| `1` | User-correctable backend/domain errors such as `invalid_request`, `not_found`, `session_not_found`, `audit_requires_ended_session`, `scope_mismatch`, `unauthorized`, and default `backend_error` cases |
| `75` | Retry-later failures: `transient`, `backend_shutting_down`, and generic HTTP `503` fallback |
| `69` | `backend_unreachable` |
| `70` | `internal`, `internal_error`, and generic HTTP `500` fallback |

## Validation Timing Matters

Two failures can both mean "bad input" and still produce different exit codes because they were caught at different stages.

Client-caught example: local CLI validation (e.g. `parseIntegerFlag`) fails before any backend request, producing `invalid_usage` and exit code `2`.

```json
{"error":true,"code":"invalid_usage","message":"--<flag> must be an integer"}
```

Server-caught example: the CLI accepts the flag shape, but backend Zod schema validation rejects the value. The call reaches the backend, which returns `invalid_request` and exit code `1` with the full issue list.

```json
{
  "error": true,
  "code": "invalid_request",
  "message": "<field>: <constraint>",
  "detail": { "issues": [{ "code": "<zod-code>", "path": ["<field>"], "message": "<constraint>" }] }
}
```

The input is wrong in both cases. The exit code differs because `invalid_usage` is rejected locally, while `invalid_request` is rejected by backend schema validation.

## `503` vs Unreachable

Two "service unavailable" cases also differ on purpose:

- `backend_shutting_down` means the backend answered and said it is draining. Exit code is `75`, which means retry later.
- `backend_unreachable` means the CLI could not talk to the backend at all. Exit code is `69`, which usually means the daemon needs to be started or restarted first.

Drain-in-progress example:

```json
{"error":true,"code":"backend_shutting_down","message":"Backend shutting down"}
```

Backend-not-running example:

```json
{"error":true,"code":"backend_unreachable","message":"fetch failed"}
```

## Consumer Examples

Retry only on retry-later failures:

```bash
#!/usr/bin/env bash
set -o pipefail

stderr_file="$(mktemp)"
if coral-cli wait --jobs "$JOB_ID" --output-format json 2>"$stderr_file"; then
  rm -f "$stderr_file"
  exit 0
fi

code="$(jq -r '.code // empty' <"$stderr_file")"
case "$code" in
  transient|backend_shutting_down)
    sleep 2
    exec "$0" "$@"
    ;;
  backend_unreachable)
    echo "Coral backend is not reachable; restart it first." >&2
    ;;
  *)
    cat "$stderr_file" >&2
    ;;
esac
```

Branch in an LLM/tool wrapper by `code`:

```ts
type CliError = { error: true; code: string; message: string; detail?: unknown };

function classify(error: CliError): 'fix-input' | 'retry' | 'restart-backend' | 'escalate' {
  switch (error.code) {
    case 'invalid_usage':
    case 'invalid_request':
    case 'not_found':
    case 'session_not_found':
    case 'scope_mismatch':
      return 'fix-input';
    case 'transient':
    case 'backend_shutting_down':
      return 'retry';
    case 'backend_unreachable':
      return 'restart-backend';
    default:
      return 'escalate';
  }
}
```
