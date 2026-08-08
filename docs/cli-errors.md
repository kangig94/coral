# CLI Errors

`coral-cli` writes a text error envelope to `stderr` for all commands. The envelope is human/LLM-facing and contains only the public message, stable tags, and optional authored remediation. Backend diagnostic context stays out of this default text surface. Parsers should not assume the message/head portion is single-line because Commander-surfaced errors may contain newlines.

`wait` and follow-mode commands keep successful human-readable text on `stdout`. Only failures move to `stderr`.

## Envelope

CLI errors use this shape:

```text
timeoutSeconds: Number must be less than or equal to 1200 [code=invalid_request, http=400]
```

Fields:

| Field         | Type             | Meaning                                                                                                                                                                  |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`     | string           | Human-readable summary. It is not guaranteed to stay on one line                                                                                                         |
| `code`        | string           | Stable programmatic error code, emitted inside the trailing tag block                                                                                                    |
| `http`        | number, optional | HTTP status when the error came from a backend HTTP response                                                                                                             |
| `remediation` | string, optional | Operator-actionable hint included by backend error paths (e.g. `kb_initializing`, `kb_offline`). Surfaced after the message so wrappers can present a concrete next step |

Backend HTTP errors are lifted into the same envelope. Transport-only diagnostic fields are not rendered.

Backend IPC errors are lifted the same way. Mutating and live commands reach the coordinator over IPC, and a JSON-RPC rejection carries its public `{code, message, remediation?}` in the error data. The CLI reads that payload, so an IPC rejection surfaces its own code and exit code rather than a generic internal failure. When an IPC rejection carries no recognized `code`, the CLI falls back to `ipc_rpc_error`.

When a backend HTTP response body is missing, non-JSON, or does not carry a `code`/`message` field, the CLI falls back to:

- `code`: `backend_error`
- `message`: the client-side HTTP status description (e.g. `HTTP 503 Service Unavailable`)

This only affects malformed or truncated backend responses. In normal operation every backend error path emits `{code, message}` and is surfaced unchanged.

## Code Catalog

| Code                                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_usage`                               | CLI-side validation failure before the request is sent. Includes local flag parsing, local integer parsing, and Commander usage errors                                                                                                                                                                                                                                                                                                              |
| `invalid_request`                             | Backend request/schema validation failure after the request reached the backend                                                                                                                                                                                                                                                                                                                                                                     |
| `not_found`                                   | Generic backend resource not found                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session_not_found`                           | Referenced session does not exist                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `audit_requires_ended_session`                | Audit/detail view was requested for a discuss session that has not ended yet                                                                                                                                                                                                                                                                                                                                                                        |
| `scope_mismatch`                              | The requested resource exists, but not in the current project/scope                                                                                                                                                                                                                                                                                                                                                                                 |
| `unauthorized`                                | Backend token/auth mismatch                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `missing_capability`                          | The authenticated principal is bound to the resource but lacks the capability the command requires. A nested (child) Coral session gets a message directing the operator to run the command from the top-level session                                                                                                                                                                                                                              |
| `child_credentials_incomplete`                | A nested Coral command ran with a partial `CORAL_*` child binding, so no request was sent. Raised CLI-side before coordinator discovery, ensure, or dispatch                                                                                                                                                                                                                                                                                        |
| `ipc_rpc_error`                               | Fallback for a coordinator IPC rejection whose error data did not provide a recognized `code`                                                                                                                                                                                                                                                                                                                                                       |
| `provider_binding_*`                          | Typed provider authority failure. Current suffixes are `missing_profile`, `profile_unavailable`, `identity_unavailable`, `profile_mismatch`, `subject_mismatch`, `unsupported_selection`, and `invalid_persisted_binding`                                                                                                                                                                                                                           |
| `provider_scope_missing`                      | The captured caller or durable operation scope does not contain every provider the operation can launch                                                                                                                                                                                                                                                                                                                                             |
| `system_provider_scope_invalid`               | Daemon startup received a malformed, incomplete, unknown-provider, relative-path, or otherwise non-canonical `CORAL_SYSTEM_PROVIDER_SCOPE`                                                                                                                                                                                                                                                                                                          |
| `system_provider_scope_unconfigured`          | HTTP or daemon-internal provider execution was requested, but the daemon booted without a named system scope                                                                                                                                                                                                                                                                                                                                        |
| `transient`                                   | Retryable HTTP failure surfaced by the client as a `TransientHttpError` instance, covering HTTP `502`/`503`/`504`. CLI-side: any `TransientHttpError` maps to exit `75` via `instanceof` dispatch; `code === 'transient'` or backend `503` bodies also land on exit `75`                                                                                                                                                                            |
| `backend_shutting_down`                       | The backend is running but draining and refusing new work                                                                                                                                                                                                                                                                                                                                                                                           |
| `backend_unreachable`                         | The backend could not be reached at all. Typical causes are not-started daemon, refused connection, or transport-level lookup/reset failures                                                                                                                                                                                                                                                                                                        |
| `kb_initializing`                             | A KB-touching command was issued while the KB daemon runtime is still starting. Transient — the daemon is healthy, only KB is not ready. Maps to HTTP `503` and exit `75` (retry-later); the response carries a `remediation` hint                                                                                                                                                                                                                  |
| `kb_offline`                                  | The KB daemon runtime is offline or failed. The daemon is otherwise healthy. Maps to HTTP `503` and exit `75`; the `remediation` hint asks the operator to restart the daemon                                                                                                                                                                                                                                                                       |
| `kb_disabled`                                 | A KB-touching command reached a coordinator whose KB daemon runtime was started with `CORAL_KB_ENABLE=0`. The daemon itself is healthy — only KB is off, and a live coordinator is never evicted by a CLI invocation just to pick up a flipped env var. Maps to HTTP `503` and exit `75`; the `remediation` hint names the operator-side restart, because a nested job cannot drain the coordinator its own parent runs on                          |
| `backend_error`                               | Fallback for a backend error response that did not provide a recognized `code`                                                                                                                                                                                                                                                                                                                                                                      |
| `internal` / `internal_error`                 | Unhandled CLI-side failure (`internal`) or backend `500` contract response (`internal_error`)                                                                                                                                                                                                                                                                                                                                                       |
| `coordinator_socket_in_use`                   | An offline operator command found the coordinator socket owned; shut down the daemon before retrying                                                                                                                                                                                                                                                                                                                                                |
| `coordinator_socket_bind_failed`              | An offline operator command could not bind the coordinator socket because of a path, permission, or platform failure                                                                                                                                                                                                                                                                                                                                |
| `startup_bundle_unresolvable`                 | Backend startup, or the offline `backend store-reset discard --target gen2` operator command, could not resolve the running bundle directory required to publish and follow the active-store selection authority                                                                                                                                                                                                                                    |
| `legacy_foreign_generation`                   | The legacy tree belongs to a different or unreadable generation; `store-reset discard --target legacy` always refuses without touching it                                                                                                                                                                                                                                                                                                           |
| `legacy_source_not_quiescent`                 | A generation-boundary operation could not acquire its lock or drain a live writer lease                                                                                                                                                                                                                                                                                                                                                             |
| `active_store_coordination_invalid`           | A filesystem trust check rejected the active-store coordination directory or selection record, or found a transition entry that could not be safely superseded                                                                                                                                                                                                                                                                                      |
| `store_newer_incompatible`                    | The active generated store has a valid product version newer than this build. Ordinary startup and the offline discard command route this classification through the active-store selection protocol, which converts it into a V3 incident instead; the code now reaches the CLI only through the store's standalone classification refusal, exercised in current code only by tests calling it directly, not by any live selection or discard path |
| `store_older_incompatible`                    | The active generated store has an older product version and a different format fingerprint                                                                                                                                                                                                                                                                                                                                                          |
| `store_corrupt_or_unsupported`                | The active generated store has missing, malformed, corrupt, or otherwise unsupported format metadata                                                                                                                                                                                                                                                                                                                                                |
| `store_not_initialized`                       | A read-only or non-daemon caller found no initialized store; only coordinator startup may create it                                                                                                                                                                                                                                                                                                                                                 |
| `kb_commit_corrupt_or_unsupported`            | A KB commit is corrupt, unsupported, or requires a different Coral version                                                                                                                                                                                                                                                                                                                                                                          |
| `kb_commit_id_invalid`                        | The requested KB commit ID is not one safe filesystem path segment                                                                                                                                                                                                                                                                                                                                                                                  |
| `kb_commit_not_found`                         | The requested KB commit is absent from the active blocking evidence                                                                                                                                                                                                                                                                                                                                                                                 |
| `kb_commit_already_quarantined`               | Retained quarantine evidence already exists for the requested KB commit                                                                                                                                                                                                                                                                                                                                                                             |
| `kb_commit_quarantine_failed`                 | Coral could not durably move and publish the requested KB commit quarantine                                                                                                                                                                                                                                                                                                                                                                         |
| `recovery_quarantine_boundary_not_registered` | The requested recovery boundary is not registered for operator retry                                                                                                                                                                                                                                                                                                                                                                                |
| `recovery_quarantine_revision_changed`        | The copied recovery coordinate is stale because the retained revision changed                                                                                                                                                                                                                                                                                                                                                                       |
| `recovery_quarantine_continuation_pending`    | The retained row is a durable continuation and direct clear is unsupported                                                                                                                                                                                                                                                                                                                                                                          |
| `recovery_quarantine_retry_in_progress`       | The canonical coordinator already owns an in-flight retry for the retained row                                                                                                                                                                                                                                                                                                                                                                      |
| `invalid_store_reset_incident_id`             | `backend store-reset report` received anything other than a canonical lowercase UUID                                                                                                                                                                                                                                                                                                                                                                |
| `store_reset_incident_not_found`              | No retained incident exists for the requested canonical UUID                                                                                                                                                                                                                                                                                                                                                                                        |
| `store_reset_incident_limit_exceeded`         | The retained root exceeded the bounded list-entry limit; direct report by known UUID remains available                                                                                                                                                                                                                                                                                                                                              |
| `store_reset_build_mismatch`                  | The installed backend, CLI, Claude helper, adjacent manifest, or embedded identity do not form one coherent current build set                                                                                                                                                                                                                                                                                                                       |
| `store_reset_incident_build_mismatch`         | The retained incident belongs to a different build set and is intentionally unreadable by the current build                                                                                                                                                                                                                                                                                                                                         |
| `store_reset_reporting_failed`                | A malformed, unsafe, over-limit, I/O, or orchestration condition prevented a safe public report                                                                                                                                                                                                                                                                                                                                                     |

## Exit Codes

| Exit | When used                                                                                                                                                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2`  | `invalid_usage`, `invalid_store_reset_incident_id`                                                                                                                                                                                                                                                                                           |
| `1`  | User-correctable backend/domain errors such as `invalid_request`, `not_found`, `session_not_found`, `audit_requires_ended_session`, `scope_mismatch`, `unauthorized`, every generation-boundary/operator code in the table below, `store_reset_incident_not_found`, `store_reset_incident_limit_exceeded`, and default `backend_error` cases |
| `75` | Retry-later failures: `transient`, `backend_shutting_down`, `kb_disabled`, `kb_initializing`, `kb_offline` (matched by code name rather than `httpStatus`, since the IPC path carries no HTTP status to match against), and generic HTTP `503` fallback (`errorCodeToExit` in `src/cli/errors.ts`)                                           |
| `69` | `backend_unreachable`                                                                                                                                                                                                                                                                                                                        |
| `77` | Authorization failures that no retry fixes: `missing_capability` and `child_credentials_incomplete`. The same code is used by `coral-cli expansion …`, whose single-JSON-line output carries these two codes as an `InstallError`                                                                                                            |
| `70` | `internal`, `internal_error`, `store_reset_build_mismatch`, `store_reset_incident_build_mismatch`, `store_reset_reporting_failed`, and generic HTTP `500` fallback                                                                                                                                                                           |

`coral-cli wait jobs` reuses exit `75` for a second, unrelated meaning that is not one of the failures above: `src/cli/follow.ts` calls `errorCodeToExit('transient')` when the bounded wait's timeout elapses, or a `waiting` event names still-running jobs, while jobs remain outstanding. That is an expected, benign pause — the jobs are still running, not failing — and the fix is to resume, not retry: rerun with the printed `--cursor` value. See [Skills](./skills.md) and the provider skill files (`clients/skills/*/SKILL.md`), which document this same code as part of the `wait jobs` monitoring contract.

### Provider-proxy role process exit codes

These are process exit codes for the backend artifact (`coral-backend.cjs`) itself when dispatched into a
guardian, reaper, or proxy role via `--provider-guardian` / `--provider-reaper` / `--provider-proxy
<capsule-path>` (`src/coordinator/bootstrap.ts`) — not `coral-cli` exit codes, and not part of the stderr
error envelope above. They let an operator reading a role process's own exit code tell which role failed to
start without correlating it against a log line, and are distinct per role and from `0` (success), `1` (a
coordinator's own generic startup failure), and `70` (`--print-store-reset-build-identity`'s own strict
identity failure):

| Exit | Role       |
| ---- | ---------- |
| `71` | `guardian` |
| `72` | `reaper`   |
| `73` | `proxy`    |

These three codes cover only a failure inside `runProviderRoleMain` after role dispatch succeeded. Parsing
the role invocation itself (`parseProviderRoleArgv`) happens earlier and is not wrapped in that same
try/catch: a malformed invocation — an unparseable or non-canonical capsule path, two role flags, or two
occurrences of the same flag — throws synchronously out of `main()` and is caught only by the top-level
`.catch()`, which exits `1`. A malformed provider-role argv therefore exits `1`, the same generic code as an
ordinary coordinator startup failure, not a distinct code.

Generation-boundary and offline-operator refusals keep the same CLI exit whether they arrive directly, over IPC, or through the HTTP gateway:

| Code                                | Direct / IPC CLI exit | HTTP status | CLI exit after HTTP lift |
| ----------------------------------- | --------------------- | ----------- | ------------------------ |
| `coordinator_socket_in_use`         | `1`                   | `409`       | `1`                      |
| `coordinator_socket_bind_failed`    | `1`                   | `409`       | `1`                      |
| `startup_bundle_unresolvable`       | `1`                   | `409`       | `1`                      |
| `legacy_foreign_generation`         | `1`                   | `409`       | `1`                      |
| `legacy_source_not_quiescent`       | `1`                   | `409`       | `1`                      |
| `active_store_coordination_invalid` | `1`                   | `409`       | `1`                      |
| `store_newer_incompatible`          | `1`                   | `409`       | `1`                      |
| `store_older_incompatible`          | `1`                   | `409`       | `1`                      |
| `store_corrupt_or_unsupported`      | `1`                   | `409`       | `1`                      |
| `store_not_initialized`             | `1`                   | `409`       | `1`                      |
| `kb_commit_corrupt_or_unsupported`  | `1`                   | `409`       | `1`                      |
| `kb_commit_id_invalid`              | `1`                   | `400`       | `1`                      |
| `kb_commit_not_found`               | `1`                   | `409`       | `1`                      |
| `kb_commit_already_quarantined`     | `1`                   | `409`       | `1`                      |
| `kb_commit_quarantine_failed`       | `1`                   | `409`       | `1`                      |

This table states the exit contract for each code if it fires; it does not claim every code is still reachable through ordinary use. `store_newer_incompatible` is the one exception — see the Code Catalog entry above for what actually produces it today.

Store-reset errors never carry `http` or diagnostic context; they carry only a fixed public-safe `remediation` selected by code. They never interpolate the supplied incident argument or a low-level filesystem/SQLite/child-process message. The successful report is written only to `stdout`; Coral creates no report file and performs no upload. If reporting itself fails, paste the complete fixed error output into the Store-reset incident issue form instead of attaching evidence or raw logs.

Provider-routing errors retain one stable code per failed authority check:

| Code                                         | Typical cause                                                               | Operator action                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `provider_binding_missing_profile`           | The required provider is absent from the captured scope                     | Select that provider profile for the caller, or configure it in the named system scope                                           |
| `provider_binding_profile_unavailable`       | The selected credential directory is missing or unreadable                  | Restore it and retry with the same absolute `CODEX_HOME` or `CLAUDE_CONFIG_DIR`                                                  |
| `provider_binding_identity_unavailable`      | The selected Codex profile exposes no consistent ChatGPT workspace identity | Run `CODEX_HOME=/abs/path codex login`, then retry. Codex API-key login is unsupported                                           |
| `provider_binding_profile_mismatch`          | Resume/recovery selected a different canonical profile                      | Retry with the original selector, or start a new session for the other profile                                                   |
| `provider_binding_subject_mismatch`          | A Codex account binding now resolves to another workspace subject           | Reauthenticate the intended Codex profile or start a new session under the new account                                           |
| `provider_binding_unsupported_selection`     | The provider or selector route is not registered                            | Use a registered provider and its documented profile selector                                                                    |
| `provider_binding_invalid_persisted_binding` | Durable state is not valid under the strict current codec                   | Stop using the affected state and start a new session/operation; do not edit or translate the record                             |
| `provider_scope_missing`                     | A multi-provider operation lacks at least one profile it may launch         | Relaunch it from a caller with every required profile selected                                                                   |
| `system_provider_scope_invalid`              | Strict named system-scope validation failed at daemon startup               | Rebuild the JSON with canonical `realpath` results, export it, and restart the daemon                                            |
| `system_provider_scope_unconfigured`         | HTTP/internal execution has no caller scope and no configured system scope  | Configure it, run `coral-cli backend shutdown`, restart through a normal mutating command, and verify `coral-cli backend status` |

The complete setup procedure and profile/account distinction are documented in [Multi-Account Provider Routing](./configuration.md#multi-account-provider-routing).

## Validation Timing Matters

Two failures can both mean "bad input" and still produce different exit codes because they were caught at different stages.

Client-caught example: local CLI validation (e.g. `parseIntegerFlag`) fails before any backend request, producing `invalid_usage` and exit code `2`.

```text
--<flag> must be an integer [code=invalid_usage]
```

Server-caught example: the CLI accepts the flag shape, but backend Zod schema validation rejects the value. The call reaches the backend, which returns an authored `invalid_request` message and exit code `1`; the raw issue list is not printed by the default CLI formatter.

```text
<field>: <constraint> [code=invalid_request, http=400]
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

## Nested Coral Commands

A `coral-cli` invoked from inside a provider job (a Coral child) reconnects to its parent coordinator and never starts or replaces one. Three failures are specific to that boundary, and all three tell the operator to go back to the top-level Coral session:

- `child_credentials_incomplete` (exit `77`) — the child binding was partial, so the command was rejected locally and no request was sent.
- `missing_capability` (exit `77`) — the child principal is valid but its capability set does not cover the command. The denial is authoritative; the parent's capability set is not negotiable from the child.
- `backend_unreachable` (exit `69`) — the parent coordinator was unreachable, draining, replaced, or too slow. The message states that no coordinator was started or replaced and points at `coral-cli backend status` from the top-level session.

`coral-cli backend shutdown` from a child is refused for the same reason and exits `1`, because a child must not drain the coordinator its parent job is running on.

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

Branch in an LLM/tool wrapper by the trailing `code` tag:

```ts
type CliError = { message: string; code: string };

function parseCliError(stderr: string): CliError {
  const match = stderr.match(/\[code=([^,\]]+)/);
  return {
    message: stderr,
    code: match?.[1] ?? 'unknown',
  };
}

function classify(error: CliError): 'fix-input' | 'retry' | 'restart-backend' | 'run-at-top-level' | 'escalate' {
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
    case 'missing_capability':
    case 'child_credentials_incomplete':
      return 'run-at-top-level';
    default:
      return 'escalate';
  }
}
```
