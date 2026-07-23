# CLI Errors

`coral-cli` writes a text error envelope to `stderr` for all commands. The envelope is human/LLM-facing: parsers should locate `\nDetail: ` as the boundary between the head and the JSON detail payload when detail is present, and should not assume the message/head portion is single-line because Commander-surfaced errors may contain newlines.

`wait` and follow-mode commands keep successful human-readable text on `stdout`. Only failures move to `stderr`.

## Envelope

CLI errors use this shape:

```text
timeoutSeconds: Number must be less than or equal to 1200 [code=invalid_request, http=400]
Detail: {"issues":[{"code":"too_big","path":["timeoutSeconds"],"message":"Number must be less than or equal to 1200"}]}
```

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `message` | string | Human-readable summary. It is not guaranteed to stay on one line |
| `code` | string | Stable programmatic error code, emitted inside the trailing tag block |
| `http` | number, optional | HTTP status when the error came from a backend HTTP response |
| `remediation` | string, optional | Operator-actionable hint included by backend error paths (e.g. `kb_initializing`, `kb_offline`). Surfaced after the message so wrappers can present a concrete next step |
| `detail` | JSON payload, optional | Extra structured detail emitted after the `Detail: ` prefix. For backend schema validation this includes `detail.issues` from Zod |

Backend HTTP errors are lifted into the same envelope. There is no nested `body` wrapper in the CLI detail payload.

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
| `provider_binding_*` | Typed provider authority failure. Current suffixes are `missing_profile`, `profile_unavailable`, `identity_unavailable`, `profile_mismatch`, `subject_mismatch`, `unsupported_selection`, and `invalid_persisted_binding` |
| `provider_scope_missing` | The captured caller or durable operation scope does not contain every provider the operation can launch |
| `system_provider_scope_invalid` | Daemon startup received a malformed, incomplete, unknown-provider, relative-path, or otherwise non-canonical `CORAL_SYSTEM_PROVIDER_SCOPE` |
| `system_provider_scope_unconfigured` | HTTP or daemon-internal provider execution was requested, but the daemon booted without a named system scope |
| `transient` | Retryable HTTP failure surfaced by the client as a `TransientHttpError` instance, covering HTTP `502`/`503`/`504`. CLI-side: any `TransientHttpError` maps to exit `75` via `instanceof` dispatch; `code === 'transient'` or backend `503` bodies also land on exit `75` |
| `backend_shutting_down` | The backend is running but draining and refusing new work |
| `backend_unreachable` | The backend could not be reached at all. Typical causes are not-started daemon, refused connection, or transport-level lookup/reset failures |
| `kb_initializing` | A KB-touching command was issued while the KB daemon runtime is still starting. Transient — the daemon is healthy, only KB is not ready. Maps to HTTP `503` and exit `75` (retry-later); the response carries a `remediation` hint |
| `kb_offline` | The KB daemon runtime is offline or failed. The daemon is otherwise healthy. Maps to HTTP `503` and exit `75`; the `remediation` hint asks the operator to restart the daemon |
| `backend_error` | Fallback for a backend error response that did not provide a recognized `code` |
| `internal` / `internal_error` | Unhandled CLI-side failure (`internal`) or backend `500` contract response (`internal_error`) |
| `invalid_store_reset_incident_id` | `backend store-reset report` received anything other than a canonical lowercase UUID |
| `store_reset_incident_not_found` | No retained incident exists for the requested canonical UUID |
| `store_reset_incident_limit_exceeded` | The retained root exceeded the bounded list-entry limit; direct report by known UUID remains available |
| `store_reset_build_mismatch` | The executing bundles, adjacent manifest, or incident do not belong to the same current build set |
| `store_reset_reporting_failed` | A malformed, unsafe, over-limit, I/O, or orchestration condition prevented a safe public report |

## Exit Codes

| Exit | When used |
| --- | --- |
| `2` | `invalid_usage`, `invalid_store_reset_incident_id` |
| `1` | User-correctable backend/domain errors such as `invalid_request`, `not_found`, `session_not_found`, `audit_requires_ended_session`, `scope_mismatch`, `unauthorized`, `store_reset_incident_not_found`, `store_reset_incident_limit_exceeded`, and default `backend_error` cases |
| `75` | Retry-later failures: `transient`, `backend_shutting_down`, and generic HTTP `503` fallback |
| `69` | `backend_unreachable` |
| `70` | `internal`, `internal_error`, `store_reset_build_mismatch`, `store_reset_reporting_failed`, and generic HTTP `500` fallback |

Store-reset errors never carry `http`, `remediation`, or `detail`, and they never interpolate the supplied incident argument or a low-level filesystem/SQLite/child-process message. The successful report is written only to `stdout`; Coral creates no report file and performs no upload.

Provider-routing errors retain one stable code per failed authority check:

| Code | Typical cause | Operator action |
| --- | --- | --- |
| `provider_binding_missing_profile` | The required provider is absent from the captured scope | Select that provider profile for the caller, or configure it in the named system scope |
| `provider_binding_profile_unavailable` | The selected credential directory is missing or unreadable | Restore it and retry with the same absolute `CODEX_HOME` or `CLAUDE_CONFIG_DIR` |
| `provider_binding_identity_unavailable` | The selected Codex profile exposes no consistent ChatGPT workspace identity | Run `CODEX_HOME=/abs/path codex login`, then retry. Codex API-key login is unsupported |
| `provider_binding_profile_mismatch` | Resume/recovery selected a different canonical profile | Retry with the original selector, or start a new session for the other profile |
| `provider_binding_subject_mismatch` | A Codex account binding now resolves to another workspace subject | Reauthenticate the intended Codex profile or start a new session under the new account |
| `provider_binding_unsupported_selection` | The provider or selector route is not registered | Use a registered provider and its documented profile selector |
| `provider_binding_invalid_persisted_binding` | Durable state is not valid under the strict current codec | Stop using the affected state and start a new session/operation; do not edit or translate the record |
| `provider_scope_missing` | A multi-provider operation lacks at least one profile it may launch | Relaunch it from a caller with every required profile selected |
| `system_provider_scope_invalid` | Strict named system-scope validation failed at daemon startup | Rebuild the JSON with canonical `realpath` results, export it, and restart the daemon |
| `system_provider_scope_unconfigured` | HTTP/internal execution has no caller scope and no configured system scope | Configure it, run `coral-cli backend shutdown`, restart through a normal mutating command, and verify `coral-cli backend status` |

The complete setup procedure and profile/account distinction are documented in [Multi-Account Provider Routing](./configuration.md#multi-account-provider-routing).

## Validation Timing Matters

Two failures can both mean "bad input" and still produce different exit codes because they were caught at different stages.

Client-caught example: local CLI validation (e.g. `parseIntegerFlag`) fails before any backend request, producing `invalid_usage` and exit code `2`.

```text
--<flag> must be an integer [code=invalid_usage]
```

Server-caught example: the CLI accepts the flag shape, but backend Zod schema validation rejects the value. The call reaches the backend, which returns `invalid_request` and exit code `1` with the full issue list.

```text
<field>: <constraint> [code=invalid_request, http=400]
Detail: {"issues":[{"code":"<zod-code>","path":["<field>"],"message":"<constraint>"}]}
```

The input is wrong in both cases. The exit code differs because `invalid_usage` is rejected locally, while `invalid_request` is rejected by backend schema validation.

## `503` vs Unreachable

Two "service unavailable" cases also differ on purpose:

- `backend_shutting_down` means the backend answered and said it is draining. Exit code is `75`, which means retry later.
- `backend_unreachable` means the CLI could not talk to the backend at all. Exit code is `69`, which usually means the daemon needs to be started or restarted first.
- `kb_initializing` and `kb_offline` mean the daemon answered, but the KB daemon runtime specifically is not ready. The daemon itself is healthy — only KB-touching commands surface these. Both map to exit `75`.

Drain-in-progress example:

```text
Backend shutting down [code=backend_shutting_down, http=503]
```

Backend-not-running example:

```text
fetch failed [code=backend_unreachable]
```

## Consumer Examples

Retry only on retry-later failures:

```bash
#!/usr/bin/env bash
set -o pipefail

stderr_file="$(mktemp)"
if coral-cli wait jobs "$JOB_ID" 2>"$stderr_file"; then
  rm -f "$stderr_file"
  exit 0
fi

stderr_text="$(cat "$stderr_file")"
case "$stderr_text" in
  *"[code=transient"*|*"[code=backend_shutting_down"*)
    sleep 2
    exec "$0" "$@"
    ;;
  *"[code=backend_unreachable"*)
    echo "Coral backend is not reachable; restart it first." >&2
    ;;
  *)
    printf '%s\n' "$stderr_text" >&2
    ;;
esac
```

Branch in an LLM/tool wrapper by `code` after splitting on `\nDetail: `:

```ts
type CliError = { message: string; code: string; detail?: unknown };

function parseCliError(stderr: string): CliError {
  const boundary = '\nDetail: ';
  const splitAt = stderr.indexOf(boundary);
  const head = splitAt === -1 ? stderr : stderr.slice(0, splitAt);
  const detailText = splitAt === -1 ? undefined : stderr.slice(splitAt + boundary.length);
  const match = head.match(/\[code=([^,\]]+)/);
  return {
    message: head,
    code: match?.[1] ?? 'unknown',
    detail: detailText === undefined ? undefined : JSON.parse(detailText),
  };
}

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
