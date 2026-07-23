# Configuration

Environment variables, plugin metadata, hooks, and flavor-aware runtime state for the current Coral runtime.

## Environment Variables

| Variable                              | Default                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORAL_CODEX_MODEL`                   | `gpt-5.6-sol`                                  | Default Codex model for new sessions when no request/agent model is set. When this baseline is a GPT-5.6 family id (`gpt-5.6*`, or bare `sol`/`terra`/`luna`), agent abstract tiers map as `opus`→`sol`, `sonnet`→`terra`, `haiku`→`luna`. For older single-size lines (e.g. `gpt-5.5`) there is no size split — abstract tiers all use this baseline. Concrete model ids pass through unchanged                                                                                                                                                                                    |
| `CORAL_CODEX_EFFORT`                  | `high`                                         | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Ceilings: Sol/Terra `ultra`, Luna `max` (no ultra), older lines e.g. `gpt-5.5` `xhigh`. Terra/Luna also floor anything below `xhigh` to `xhigh`                                                                                                                                                                                                                                                                                                                                                          |
| `CORAL_CODEX_FAST`                    | _(none)_                                       | Codex fast-mode toggle. `1` = fast (priority), `0` = explicit `default` (fast off). Any other non-blank value is rejected. Blank/unset falls back to `service_tier` (`default`, `fast`, or `flex`) in the selected `$CODEX_HOME/config.toml`, then Codex default. Env takes precedence over config.toml. Profile-scoped `service_tier` under `[profiles.xxx]` is ignored                                                                                                                                                                                                            |
| `CORAL_CLAUDE_MODEL`                  | _(none)_                                       | Default model for the Claude sessions Coral launches. Either a tier alias (`fable`, `opus`, `sonnet`, `haiku`), capped by `CORAL_CLAUDE_MODEL_CAP` (an alias above the cap is replaced by the cap tier), or a specific model id passed to Claude as-is — e.g. `opus[1m]` (the 1M-context Opus) or a full name like `claude-opus-4-8`; specific ids are not tier-capped. Unset/empty leaves the model unspecified so Claude uses its own default. An explicit per-request model wins. The default cap remains `opus`, so selecting Fable requires setting the cap to `fable` as well |
| `CORAL_CLAUDE_EFFORT`                 | `xhigh`                                        | Claude reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Sonnet/Haiku have no `xhigh` level — the adapter collapses `xhigh` to the provider ceiling (`max`) on those tiers                                                                                                                                                                                                                                                                                                                                                                                                |
| `CORAL_CLAUDE_MODEL_CAP`              | `opus`                                         | Maximum Claude model tier, ordered `fable` > `opus` > `sonnet` > `haiku`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CORAL_CLAUDE_TRANSPORT`              | `print`                                        | Claude broker transport. `print` (also `p` or `stream-json`) launches `claude -p --input-format stream-json --output-format stream-json` and drives turns over JSONL. `tui` (also `pty` or `interactive`) launches interactive Claude through a PTY and derives completion from Claude's JSONL transcript. The value is forwarded per request and participates in provider-server identity, so print and TUI brokers are never reused as the same process. Usage reporting differs by transport: print reports provider cost, while TUI contributes tokens only                     |
| `CORAL_EFFORT`                        | _(none)_                                       | Global effort fallback used only when the provider-specific `CORAL_{CLAUDE,CODEX}_EFFORT` is unset. Explicit request-body effort wins over all env vars                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CORAL_OWNER`                         | _(none)_                                       | Default owner id for owner-attributed operations (e.g. the `--owner` fallback for `coral-cli kb memo` and session/memo attribution). An explicit `--owner` flag or request field wins. Token-safe values only                                                                                                                                                                                                                                                                                                                                                                       |
| `CORAL_DEV_ASSERTIONS`                | _(none)_                                       | Contributor-only developer assertions. Set `1` during local development or `npm test` to make stale continuity-bridge calls throw instead of silently no-oping, and to throw on dispatcher corrupt-state cases. Leave unset for production behavior; never enable in production deploys                                                                                                                                                                                                                                                                                             |
| `CORAL_MAX_WORKERS`                   | `10`                                           | Max concurrent workers (1–20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CORAL_MAX_QUEUE_SIZE`                | `20`                                           | Max queued launches before Coral returns `busy` (1–1000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CORAL_DISCUSS_MAX_WORKERS`           | `5`                                            | Max concurrent discuss workers (1–10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CORAL_DISCUSS_MAX_EPOCHS`            | `2`                                            | Maximum discuss epochs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CORAL_BACKEND_IDLE_MS`               | `21600000`                                     | Backend idle timeout in ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CORAL_JOBS_RETENTION_DAYS`           | `14`                                           | Days to keep a terminal job's export artifacts (`~/.coral/exports/jobs/<id>/result.md`) before backend startup prunes them. The export dir is a rebuildable cache of the journal — `result.md` is regenerated from the journal terminal event on the next read — so pruning only reclaims disk; `jobs list`/`detail` still resolve from the journal. Invalid/non-positive values fall back to the default                                                                                                                                                                           |
| `CORAL_BACKEND_BIND`                  | `127.0.0.1`                                    | Backend HTTP bind address. Loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) work without extra configuration; non-loopback binds such as `0.0.0.0` require `CORAL_BACKEND_ALLOW_REMOTE=1` plus either `CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST` or `CORAL_BACKEND_REMOTE_UNRESTRICTED=1`                                                                                                                                                                                                                                                                                              |
| `CORAL_BACKEND_ALLOW_REMOTE`          | _(none)_                                       | Explicit opt-in for non-loopback `CORAL_BACKEND_BIND` values. Set to `1` only when remote backend exposure is intentional and protected by a trusted network boundary                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST` | _(none)_                                       | Comma-separated exact client IP allowlist required for non-loopback backend binds unless `CORAL_BACKEND_REMOTE_UNRESTRICTED=1` is set. IPv4-mapped IPv6 entries are normalized to IPv4. CIDR ranges and hostnames are not accepted                                                                                                                                                                                                                                                                                                                                                  |
| `CORAL_BACKEND_REMOTE_UNRESTRICTED`   | _(none)_                                       | Explicitly permits token-only HTTP access on a non-loopback bind when set to `1`. This emits a warning audit event and should only be used behind an external access-control boundary                                                                                                                                                                                                                                                                                                                                                                                               |
| `CORAL_BACKEND_ADVERTISE_HOST`        | _(bind value)_                                 | Hostname clients use to reach the backend. Distinct from `CORAL_BACKEND_BIND` when the bind interface differs from the externally reachable name (NAT, container host)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CORAL_BROKER_IDLE_MS`                | `300000`                                       | Provider host (broker) idle eviction window in ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CORAL_BOOT_FRESHNESS_TIMEOUT_MS`     | `90000`                                        | Coordinator boot freshness wait (ms, the same `CONTENDER_BUDGET` used by lock acquisition). Lower for tighter integration test loops; rarely tuned in production. The KB daemon shares this readiness budget too — it is forwarded to the daemon via `PARENT_FORWARDED_KB_ENV` (see KB Daemon Environment Forwarding below)                                                                                                                                                                                                                                                         |
| `CORAL_DISCOVERY_PROBE_CLK_TCK`       | _(unset)_                                      | Linux-only debug gate. Set `1` to invoke `getconf CLK_TCK` instead of assuming the standard value of 100. Leave unset on every modern Linux                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CORAL_AUTO_SYMLINK`                  | `0`                                            | Auto-create `.claude/coral` symlink on session start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CORAL_FLAVOR`                        | `prod` when unset                              | Hook selector (`prod` or `dev`) for dev/prod coexistence. It controls which hooks fire, not daemon identity. For hooks, set it in Claude Code settings `env`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CORAL_SYSTEM_PROVIDER_SCOPE`         | _(none)_                                       | Strict JSON named system scope used by HTTP and daemon-internal provider work. The object must have `origin: "system"`, a non-empty `name`, and one provider-owned canonical profile per provider. It is read and validated at daemon boot; changing it requires a restart. If unset, HTTP/internal provider launch is disabled rather than falling back to daemon credentials                                                                                                                                                                                                      |
| `CODEX_HOME`                          | caller home + `/.codex`                        | Codex credential home selected by each local CLI invocation. Coral requires an absolute path, resolves it to its physical directory, binds the provider session to the workspace identity in that profile, and uses that same binding for launch, resume, recovery, and artifact cleanup                                                                                                                                                                                                                                                                                            |
| `CLAUDE_CONFIG_DIR`                   | caller home + `/.claude`                       | Claude credential/config directory selected by each local CLI invocation. Coral requires an absolute path and persists a profile-level binding. An explicit selector is injected as `CLAUDE_CONFIG_DIR`; the caller-local default is reproduced with its exact bound `HOME` and no inherited `CLAUDE_CONFIG_DIR`. Daemon boot state is never provider authority                                                                                                                                                                                                                     |
| `CORAL_KB_PATH`                       | `~/.coral/kb` (prod) / `~/.coral/kb-dev` (dev) | KB markdown-root override. Runtime KB state remains flavor-separated under `~/.coral/data/kb/` or `~/.coral/data-dev/kb/`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CORAL_KB_IMPORT_MAX_BYTES`           | `1073741824` (1 GiB)                           | Admin KB source-import cap in bytes, read from the backend daemon's environment at startup. `0` or `unlimited` disables the admin byte cap. Changing it requires exporting the var and restarting the backend daemon; setting it in an ad-hoc CLI shell does not affect an already-running daemon                                                                                                                                                                                                                                                                                   |
| `CORAL_KB_GIT_SYNC`                   | `0`                                            | Enable KB git sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CORAL_KB_ENABLE`                     | _(unset → enabled)_                            | Set `0` to boot the daemon without spawning the KB daemon — no corpus indexing, curate, retrieval, or KB content injected into sessions/agents. `1` or unset enables it; a malformed value warns once and leaves KB enabled. Read from the daemon's environment at startup like `CORAL_KB_IMPORT_MAX_BYTES`. Flipping `0`→`1` and running any `kb …` command transparently restarts the daemon to bring KB online (that one command waits for daemon-ready; KB daemon boot remains non-blocking)                                                                                    |
| `GEMINI_API_KEY`                      | _(none)_                                       | API key the Gemini embedding expansion reads when equipped (`coral-cli expansion equip gemini`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Multi-Account Provider Routing

Coral runs one account-neutral daemon and store per flavor. Provider selectors never choose a socket, daemon, or Coral state directory. Each local CLI invocation captures only the providers that operation can launch: `CODEX_HOME` selects a Codex profile and `CLAUDE_CONFIG_DIR` selects a Claude profile. If either variable is unset, Coral constructs the explicit caller-local default shown above and canonicalizes it; it never inherits selector state from the process that booted the daemon.

The provider module turns a canonical profile into durable session authority. Codex creates an **account binding** from the provider-managed workspace routing identity exposed by `tokens.account_id`; when the ID token also carries OpenAI's workspace claim, both values must agree. Claude exposes no stable non-secret account identity through the supported CLI surface, so Coral creates a **profile binding** and does not call it account verification. The local credential directory is the trust boundary: Coral detects profile drift and Codex workspace changes, but does not claim protection from an attacker who can rewrite those local files.

Provider jobs must match their owning binding. A workflow and discussion each persist their complete provider scope on the aggregate root; a real `ProviderSession` is created only when a provider conversation begins. Every job separately persists its `ExecutionOwner`, so workflow/discussion ownership never masquerades as provider continuity. Each system one-shot binds the configured system scope at the point of use. Claude's broker remains account-neutral while its controller receives either the explicit bound config directory or the exact home that owns the default `.claude`; Codex app-server identity includes the bound home. Codex account bindings require ChatGPT auth, pin thread start/resume/recovery to the official OpenAI model provider, and validate Codex's effective config before a thread operation; alternate credential stores, model providers, base URLs, remote thread config, and config lockfiles fail closed. Caller-supplied API keys, auth tokens, provider base URLs, and alternate cloud selectors likewise cannot override either provider's selected profile.

Selectors must be absolute paths. Shell expansion happens before Coral runs, so use an expanded absolute path; a literal `~` or a relative path is rejected. On a fresh machine, authenticate each profile in the directory that Coral will select:

```bash
CODEX_HOME=/abs/path/to/codex-profile codex login
CLAUDE_CONFIG_DIR=/abs/path/to/claude-profile claude auth login
```

Coral supports Codex ChatGPT login for account binding. Codex API-key login is unsupported and fails closed because it does not provide the workspace identity that the binding requires.

After authentication, select the same directories for each invocation:

```bash
CODEX_HOME=/home/me/accounts/codex-work coral-cli codex -i 'review this change'
CLAUDE_CONFIG_DIR=/home/me/accounts/claude-work coral-cli claude -i 'review this change'
```

Resuming with another canonical profile fails as `provider_binding_profile_mismatch` before preflight or queue admission. Codex reauthentication to another workspace fails as `provider_binding_subject_mismatch`. Unavailable profiles, missing workspace identity, unsupported selectors, and invalid durable bindings remain separate typed failures. Resume with the original `CODEX_HOME`/`CLAUDE_CONFIG_DIR`, or start a new session after authenticating the intended profile.

HTTP and daemon-internal provider work have no caller environment, so they require a named system scope. Configure it in this order: authenticate the profiles, resolve each directory to its physical absolute path, export descriptors containing those canonical paths (never tokens or account subjects), restart the daemon, then inspect status.

```bash
CODEX_HOME=/abs/path/to/codex-system codex login
CLAUDE_CONFIG_DIR=/abs/path/to/claude-system claude auth login

realpath /abs/path/to/codex-system
realpath /abs/path/to/claude-system

# Substitute the two realpath results below.
export CORAL_SYSTEM_PROVIDER_SCOPE='{"origin":"system","name":"automation","profiles":[{"provider":"claude","profile":{"canonicalLocation":"/canonical/claude-system","routing":{"kind":"config-dir","emitConfigDir":true}}},{"provider":"codex","profile":{"canonicalLocation":"/canonical/codex-system","routing":{"kind":"home"}}}]}'

coral-cli backend shutdown
# This normal provider command relaunches the daemon with the exported scope.
CLAUDE_CONFIG_DIR=/canonical/claude-system coral-cli claude -i 'Reply READY.'
coral-cli backend status
```

KB curate execution and its usage-budget guard resolve the Claude profile from this same verified system scope. The KB daemon never consults the account that happened to boot it. Detailed health reports only the system-scope name and provider names, never the raw profile descriptors.

The scope is strict: duplicate providers, unknown providers, relative locations, unknown fields, and malformed provider profiles stop daemon startup. A valid profile is rebound and checked before every provider use. HTTP clients cannot submit `providerScope`; they receive `system_provider_scope_unconfigured` until the daemon has a configured scope. Detailed health exposes only the scope name and provider names, never paths, subjects, or credential material. `backend status` must report that named scope and its provider names after restart; otherwise inspect the startup error before retrying provider work.

Provider-routing failures are intentionally distinct so the operator can repair the correct authority:

| Code                                         | Cause                                                                             | Action                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `provider_binding_missing_profile`           | The required provider is absent from the captured scope                           | Invoke from a caller that selects that provider profile, or add that provider profile to the named system scope                     |
| `provider_binding_profile_unavailable`       | The selected credential directory cannot be resolved or read                      | Restore the directory and permissions, then retry with the same absolute selector                                                   |
| `provider_binding_identity_unavailable`      | The selected Codex profile exposes no consistent ChatGPT workspace identity       | Run `CODEX_HOME=/abs/path codex login` for that profile, then retry; API-key login is unsupported                                   |
| `provider_binding_profile_mismatch`          | Resume/recovery selected a different canonical profile                            | Use the original `CODEX_HOME` or `CLAUDE_CONFIG_DIR`; start a new session when a different profile is intended                      |
| `provider_binding_subject_mismatch`          | A Codex profile now resolves to a different workspace account                     | Reauthenticate the intended Codex profile or start a new session under the new account                                              |
| `provider_binding_unsupported_selection`     | The selector or provider route is outside the registered provider contract        | Choose a registered provider and its documented `CODEX_HOME`/`CLAUDE_CONFIG_DIR` route                                              |
| `provider_binding_invalid_persisted_binding` | Durable state does not decode as the strict current binding codec                 | Stop using the affected state and start a new session/operation; do not edit or translate the record                                |
| `provider_scope_missing`                     | The operation's captured scope does not cover every provider it can launch        | Relaunch the operation from a caller with all required provider profiles selected                                                   |
| `system_provider_scope_invalid`              | `CORAL_SYSTEM_PROVIDER_SCOPE` is malformed, incomplete, or non-canonical          | Rebuild the strict JSON from `realpath` results, export it, and restart the daemon                                                  |
| `system_provider_scope_unconfigured`         | HTTP/internal work requested a provider but daemon boot had no named system scope | Configure the named scope, run `coral-cli backend shutdown`, restart through a normal mutating command, and verify `backend status` |

See [CLI Errors](./cli-errors.md) for the wire envelope and exit-code behavior.

`ProviderBindingEnvelope`, `ProviderScope`, journal events, and projections carry no migration versions. Coral provides no upcaster, dual reader, default fill, or old-format decoder. The active `StoreFormatFingerprint` covers the executable SQL manifest, explicit event body/materializer and append-validator semantic contracts, persisted decoder contracts, and each provider's profile, binding, and continuity codecs. Startup quarantines the DB/WAL/SHM plus the redundant hook-safety format sidecar and creates a fresh store whenever the database fingerprint is missing or differs; it never translates old durable state.

#### Store-reset incidents

A reset is unconditional and needs no confirmation. Active Coral history and state from the previous store are unavailable after the reset; KB Markdown is unaffected. A completed quarantine is retained indefinitely as a **store-reset incident** under the current flavor's `store-reset-quarantine/<incident-id>/` directory. It is support evidence, not recoverable product state: Coral provides no restore, migration, compatibility reader, upload, telemetry, pruning, or automatic issue creation.

Use the daemon-independent local commands:

```bash
coral-cli backend store-reset list
coral-cli backend store-reset report <incident-id>
```

They work whether the daemon is stopped, unhealthy, or running. Reports are accepted only when the incident, backend bundle, CLI bundle, and adjacent package manifest belong to the same current build set. Upgrading may therefore make an older retained incident unreadable by design.

The generated Markdown contains only allowlisted build/reset metadata, recorded file sizes and hashes, fixed verification states, and a fixed SQLite integrity state. It excludes paths, namespace and process identifiers, rows, prompts, event bodies, environment values, credentials, account/workspace identifiers, child output, and raw exception or SQLite text. If a reset was unexpected, paste that generated report into the **Store-reset incident** GitHub issue form and describe the preceding command/update sequence. Never attach DB/WAL/SHM files, `.env` or settings files, credentials, tokens, or unredacted logs.

Inspection is intentionally bounded: list reads at most 4,097 root entries and rejects overflow; an incident may contain only the manifest plus four canonical evidence names; the manifest is limited to 64 KiB and JSON depth 8; report hashing is capped at 1 GiB; SQLite staging is capped at 256 MiB. SQLite runs only against a private temporary copy with a 5-second execution deadline, 1-second graceful termination window, 1-second forced-close window, 64-byte stdout cap, and 4 KiB stderr cap. Limit, cleanup, and termination failures become fixed statuses rather than partial or raw output.

#### Upgrade cutover

This release does not support old and new daemon generations running together. Treat upgrade as an operator-owned gate:

1. Quiesce every Orca session, hook, terminal, and automation that can invoke the old bundle, and keep them disabled.
2. Inventory every legacy account context and run its old authenticated `coral-cli backend shutdown`.
3. Verify every old process has exited and every legacy socket rejects connections.
4. Replace the installed bundle.
5. Start and verify the single canonical daemon.
6. Re-enable Orca sessions, hooks, terminals, and automations.

The new runtime deliberately does not discover, migrate, delete, or fence old `by-config` trees. Complete the cutover before allowing any new invocation.

### HTTP Exposure

The default backend HTTP bind is loopback-only. If `CORAL_BACKEND_BIND` is set to a non-loopback address, Coral refuses to start unless `CORAL_BACKEND_ALLOW_REMOTE=1` is set and a remote access policy is configured. Prefer `CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST` with exact trusted client IPs. `CORAL_BACKEND_REMOTE_UNRESTRICTED=1` keeps token-only access available for deployments that enforce access outside Coral, but it emits a warning audit event and should only be used behind a trusted reverse proxy or private network boundary. Coral grants browser CORS only to loopback origins; non-browser clients still authenticate with the backend token.

### Proxy and TLS Forwarding

Provider processes receive a closed environment rather than the daemon's whole inherited environment. The allowlist contains the normal process basics plus `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (upper- and lower-case), `SSL_CERT_FILE`, `SSL_CERT_DIR`, and `NODE_EXTRA_CA_CERTS`. Empty and unrelated values, API keys, auth tokens, provider base URLs, and account selectors supplied in request env are excluded; Coral then injects the source-bound `CODEX_HOME`, the explicit bound `CLAUDE_CONFIG_DIR`, or the exact bound `HOME` for Claude's caller-local default, plus server-minted child authority.

The forwarded env participates in provider reuse decisions, so a changed proxy re-establishes provider state rather than silently reusing a stale one — but the providers differ in mechanism. Codex carries this env in its provider-server spec, so a different proxy keys a distinct Codex broker process. Claude carries only `CORAL_CLAUDE_TRANSPORT` in its provider-server spec; network env enters the Claude session env hash, and a mismatch forces a fresh session bootstrap on that broker rather than a new broker process.

### Session Config Forwarding

The provider config resolved _per request_ — the model/effort/transport knobs `CORAL_CODEX_MODEL`, `CORAL_CODEX_EFFORT`, `CORAL_CODEX_FAST`, `CORAL_CLAUDE_MODEL`, `CORAL_CLAUDE_MODEL_CAP`, `CORAL_CLAUDE_EFFORT`, `CORAL_CLAUDE_TRANSPORT`, `CORAL_EFFORT`, plus the owner-attribution fallback `CORAL_OWNER` — must not be frozen to the long-lived daemon's boot environment. Because the `coral-cli` process Claude Code launches for each invocation already carries the current `settings.json` env, Coral forwards the caller's full `CORAL_*` config on every provider launch (and KB mutation) as an **authoritative** `coralEnv` map: the caller's value wins over the daemon's boot value, and a key the caller _unset_ is absent — so the provider falls back to its code default (e.g. removing `CORAL_CODEX_MODEL` from `settings.json` reverts new Codex sessions to `gpt-5.6-sol`). A change to one of these variables therefore reaches a spawned provider on the next `coral-cli` invocation **run in a session started after the edit** (see [`.claude/settings.json`](#claudesettingsjson) below — env is fixed onto the Claude Code process at session start), with **no backend restart** on top of that.

Daemon-owned keys are never taken from this forwarded map, by two different mechanisms. Child identity/auth is set fresh per request or minted server-side, never carried from the caller: `CORAL_JOB_ID`/`CORAL_SESSION_ID` come from the request's validated lineage fields, `CORAL_CHILD_PRINCIPAL_HANDLE` is minted per child, and `CORAL_CHILD` is stamped by the child-env composer. Boot-fixed infra (the build-flavor key, `CORAL_KB_PATH`, `CORAL_ENV_PASSTHROUGH`, startup markers) is instead re-asserted from the daemon's own boot snapshot, so a nested `coral-cli` inside a provider targets the right daemon rather than one a caller names. `CORAL_KB_ENABLE` is likewise daemon-owned: it gates whether the daemon booted its KB runtime, and although the injection step reads it per request, it must reflect the daemon's actual KB state — so a caller cannot forward it (to flip it, change the daemon's boot env and restart, or use the `0`→`1` re-enable path, which reads the CLI's own env, not `coralEnv`). Like `networkEnv`, this forwarding is trusted only from local IPC/loopback callers; a remote HTTP client that sends `coralEnv` is rejected with `remote_transport_option_forbidden`.

Because a forwarded value now reaches a live provider turn, an invalid `CORAL_*_EFFORT` (`CORAL_CODEX_EFFORT` / `CORAL_CLAUDE_EFFORT` / `CORAL_EFFORT`) is tolerated: the daemon warns and ignores it, falling back to the provider's default effort rather than failing the job. An effort supplied as a request field (e.g. an explicit flag) is still validated strictly at ingress and rejected before launch.

This does **not** promote boot-only knobs. Variables the daemon reads once at startup (`CORAL_MAX_WORKERS`, `CORAL_MAX_QUEUE_SIZE`, the `CORAL_*_IDLE_MS` timers, `CORAL_KB_*`, `CORAL_KB_IMPORT_MAX_BYTES`, the backend-bind vars, …) are consumed at boot rather than per request, so changing them still requires a backend restart even though they now ride the wire.

### Provider Usage Reporting

Provider usage reporting has no pricing configuration knob in Coral. Provider jobs capture usage automatically at the provider boundary and store the normalized summary in the job terminal record's `diagnostics.usage` field (`projection_jobs.diagnostics` in the read model). The stored shape is additive: `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, and optional provider-reported `costUsd`. `totalTokens` is derived only when rendering.

Cost availability depends on the provider and transport. Claude print reports `total_cost_usd`, so wait/detail can render a dollar segment. Claude TUI has no cost in the transcript and renders tokens only. Codex reports tokens only, captured from the native `thread/tokenUsage/updated` notification (`tokenUsage.total`); its `cachedInputTokens` are part of `inputTokens`, so Coral stores fresh input as `inputTokens - cachedInputTokens` and stores cached input as `cacheReadTokens`.

Workflow jobs do not store an aggregate usage payload on `workflow.completed`. Wait and `coral-cli jobs detail <jobId>` sum child job terminal diagnostics at read time by `parent_workflow_job_id`. If some children have cost and others do not, the rendered workflow cost uses `$X+` with `(+N jobs without cost data)`.

The visible surfaces are `coral-cli wait` terminal completion lines, `coral-cli wait jobs --verbose`, and `coral-cli jobs detail <jobId>`. When cache reads are at least half of the token total, the CLI adds `(NN% cached)` so large cache-read totals are not presented as fresh context size.

### KB Daemon Environment Forwarding

The KB daemon runs as a separate child process the coordinator spawns. Child spawns pass through a sanitizer (`composeChildEnv`) that strips **every** inherited `CORAL_*` variable, so KB configuration set on the backend daemon would otherwise never reach the KB daemon that actually reads it.

To make this predictable, KB configuration follows one convention: **every CORAL variable the KB daemon reads carries the `CORAL_KB_` prefix** (`CORAL_KB_EXTRA_LANGS`, `CORAL_KB_IMPORT_*`, `CORAL_KB_CORPUS_SCAN_*`, `CORAL_KB_CURATE_*`, `CORAL_KB_GIT_SYNC`, …). The supervisor forwards the whole prefix to the KB daemon at spawn time, so any KB knob set in the backend daemon's environment reaches the daemon — and a newly added KB variable cannot be silently dropped as long as it carries the prefix (enforced by `tests/invariants/kb-daemon-env-prefix.test.ts`). A small allowlist forwards shared knobs whose primary owner is the coordinator and that therefore keep a non-`CORAL_KB_` name (currently `CORAL_BOOT_FRESHNESS_TIMEOUT_MS`). As with all daemon-environment settings, these are read from the backend daemon's frozen boot environment — export them before starting the daemon; an ad-hoc CLI shell does not affect an already-running daemon.

### KB Source Imports

Source-import authority is interim and transport-derived: local IPC calls run as `admin`; HTTP calls run as `user`. The request body is not a trust signal. Admin imports, representing the local IPC owner, may read any file path the daemon account can read and use the admin size cap from `CORAL_KB_IMPORT_MAX_BYTES`, defaulting to 1 GiB. User imports are sandboxed to the project root and always have a fixed 128 MiB cap.

`CORAL_KB_IMPORT_MAX_BYTES` is a daemon-startup setting. The daemon reads it from its frozen runtime environment snapshot when it starts, so cap changes require exporting the variable in the daemon-startup environment and restarting the backend daemon. Setting `CORAL_KB_IMPORT_MAX_BYTES` ad hoc in a CLI shell does not affect an already-running daemon.

Real role-based auth (login / admin-vs-user tokens) is future work.

### Shell Usage

```bash
export CORAL_CODEX_MODEL=gpt-5.6-sol
export CORAL_CODEX_EFFORT=high
export CORAL_DISCUSS_MAX_EPOCHS=3
export CORAL_KB_PATH=/path/to/my-kb
export CORAL_KB_ENABLE=0   # boot the daemon without the KB daemon; set to 1 (or unset) to re-enable
export CORAL_CLAUDE_TRANSPORT=tui   # opt into the PTY transport; unset/default uses claude -p stream-json
```

`CORAL_KB_ENABLE` is re-read at daemon startup. Setting it while a daemon is already running takes effect only after a restart — but setting it to `1` and running any `kb …` command triggers that restart automatically, so no manual `coral-cli backend shutdown` is needed.

Unset `CORAL_FLAVOR` is treated as `prod`. Hooks use it only to decide whether the current hook bundle should run; daemon identity still comes from `bridge/manifest.json`. For local dev hooks, prefer the project `.claude/settings.local.json` `env` block over shell exports so Claude Code launches hooks with the intended flavor consistently.

### `.claude/settings.json`

Project-level or global Claude Code settings can persist the same environment variables:

```json
{
  "env": {
    "CORAL_CODEX_MODEL": "gpt-5.6-sol",
    "CORAL_CODEX_FAST": "1",
    "CORAL_DISCUSS_MAX_EPOCHS": "3",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Changes to `settings.json` env take effect on the next Claude Code session start. Per-request provider config (`CORAL_CODEX_MODEL`, `CORAL_CODEX_FAST`, `CORAL_CLAUDE_TRANSPORT`, and the other model/effort knobs) is additionally re-resolved from the forwarded `coralEnv` on each provider request, so within a session started after the edit those changes reach a spawned provider on the next `coral-cli` invocation with no backend restart (see [Session Config Forwarding](#session-config-forwarding) above). Boot-only knobs (worker/queue limits, idle timers, `CORAL_KB_*`) still require a restart.

### Embedding credentials

Embedding credentials (e.g. `GEMINI_API_KEY`) are read from the backend's process environment. Set them in the user-level `~/.claude/settings.json` `env` block or your shell profile — not in repo-checked settings — then restart the backend (`coral-cli backend shutdown`; the next command relaunches it with the new environment).

## Config Files

The installable plugin surface lives under `clients/` (the plugin root — it holds `.claude-plugin/plugin.json`, `.codex-plugin/`, `agents/`, `skills/`, `hooks/`, `bridge/`, `methods/`, and `inject/`). The root `.claude-plugin/marketplace.json` stays at the repo root and points at `./clients` via a `git-subdir` source. At install time the `clients/` level is flattened away, so `${CLAUDE_PLUGIN_ROOT}` resolves to a directory that contains `bridge/`, `hooks/`, etc. directly.

### `clients/.claude-plugin/plugin.json`

Claude Code plugin manifest. Relevant fields:

| Field                                            | Purpose                                 |
| ------------------------------------------------ | --------------------------------------- |
| `name`                                           | Plugin name and slash-command prefix    |
| `version`                                        | Synced from `package.json` during build |
| `description`                                    | Plugin description shown to the host    |
| `author` / `repository` / `homepage` / `license` | Package metadata                        |
| `skills`                                         | Relative path to the skill directory    |

The manifest is limited to plugin metadata and the skill path. Transport registration is not part of the manifest.

### `clients/bridge/manifest.json`

Build manifest written by `scripts/build-server.mjs`:

```json
{
  "bundleHash": "<backend-bundle-hash>",
  "flavor": "prod",
  "storeFormatFingerprint": "sha256:<canonical-store-format-hash>"
}
```

`bundleHash` tracks backend bundle bytes. `flavor` is the intrinsic build identity used by the backend and hooks to distinguish prod from dev. `storeFormatFingerprint` is emitted by that exact backend bundle; standalone read-only hooks verify it before reading Coral's SQL projections.

### `clients/hooks/claude.json` and `clients/hooks/codex.json`

Per-client hook registration, each referenced by its own `plugin.json` (`.claude-plugin` → `./hooks/claude.json`, `.codex-plugin` → `./hooks/codex.json`). `claude.json` is the full set (SessionStart, compact recovery, SubagentStart, PreCompact, PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop); `codex.json` is the same minus the Claude-only hooks (`hud-auto-update`, the `SubagentStart`/`SubagentStop` scripts, and the `PreToolUse(Monitor)` guard). See [Hooks](./hooks.md) for behavior details.

## Runtime State Files

### Backend state

| Path                                                                   | Purpose                               |
| ---------------------------------------------------------------------- | ------------------------------------- |
| `~/.coral/run/coordinator.json` or `~/.coral/run-dev/coordinator.json` | Active coordinator discovery record   |
| `~/.coral/run/coordinator.lock` or `~/.coral/run-dev/coordinator.lock` | Per-flavor singleton coordinator lock |

### Session state

Provider sessions are Journal events projected into `projection_sessions`. Every row is a real provider conversation with one strict binding; provider identity derives from that binding. `SessionManager` scopes lookups with `scope_key`, derived from the project root namespace; it no longer owns JSON session files. Workflow and discussion lifecycle/scope live in their own aggregates, not in synthetic session rows.

### Discuss state

Discuss sessions are Journal events projected into `projection_discuss`. The source-scoped discovery and summary views are read models over those projections; discuss no longer owns JSON session files. On final synthesis, a completed discussion is also exported as a human-readable markdown record at `~/.coral/projects/<source-slug>/discuss/<YYYYMMDD-HHMMSS>-<topic-slug>.md` — a rebuildable projection of the Journal, not authority (see [discuss.md](./discuss.md)).

### KB state

- Markdown root defaults: `~/.coral/kb/` for prod, `~/.coral/kb-dev/` for dev
- Runtime state defaults: `~/.coral/data/kb/` for prod, `~/.coral/data-dev/kb/` for dev
- `CORAL_KB_PATH` still overrides the markdown root only
- `<runtime-state>/orama/` stores the derived base retrieval snapshot when the Orama CorpusConsumer has applied the current Corpus snapshot
- `<runtime-state>/needle/` and `<runtime-state>/needle-staging/` are optional Needle expansion artifacts, created only when the Needle expansion is equipped
- Source import staging is machine-local runtime state; clients pass source `filePath`, not a staged markdown path

### Job state

Durable result exports:

- prod: `~/.coral/exports/jobs/<jobId>/result.md`
- dev: `~/.coral/exports-dev/jobs/<jobId>/result.md`

Live scratch artifacts:

`<os-tmpdir>/coral-jobs/<jobId>/`

- provider runtime scratch files such as stdout/stderr/env artifacts, owned by the runtime transport
- KB source imports and explicit reindex runs are internal jobs in the Journal/store, not provider/session jobs; CLI display may label them as KB work even though `session_id` and `provider` are null in the projection

## Runtime Dependencies

| Package                          | Purpose                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `zod`                            | Schema validation                                                 |
| `@orama/orama`                   | Base KB retrieval projection and fallback vector search           |
| `graphology`                     | Graph data structures for KB community analysis                   |
| `graphology-communities-louvain` | Community detection                                               |
| `mammoth` / `turndown`           | Source import conversion                                          |
| `@lydell/node-pty`               | Interactive Claude CLI broker transport                           |
| `commander`                      | CLI command parsing (bundled into `clients/bridge/coral-cli.cjs`) |
| `yaml`                           | YAML parsing                                                      |
| `zod-to-json-schema`             | Schema export helpers                                             |

## External Dependencies

| Tool        | Purpose                                    |
| ----------- | ------------------------------------------ |
| Codex CLI   | Codex execution                            |
| Claude CLI  | Claude execution through the broker helper |
| Node.js 24+ | Runtime                                    |
| `cmake`     | Native KB addon fallback builds            |

## File Role Summary

```text
.claude-plugin/marketplace.json                -> marketplace catalog (repo root; git-subdir -> ./clients)
clients/.claude-plugin/plugin.json             -> plugin manifest
clients/.codex-plugin/plugin.json              -> Codex plugin manifest
clients/hooks/claude.json                       -> hook registration (Claude Code, full set)
clients/hooks/codex.json                        -> hook registration (Codex, subset)
clients/bridge/coral-backend.cjs                -> backend daemon bundle
clients/bridge/coral-cli.cjs                    -> CLI bundle
clients/bridge/coral-claude-appserver.cjs       -> Claude broker helper bundle
clients/bridge/manifest.json                    -> backend bundle hash + build flavor

~/.coral/run*/coordinator.json                 -> active coordinator discovery record
~/.coral/run*/coordinator.lock                 -> per-flavor coordinator singleton lock
projection_sessions in store.db                -> projected provider session continuity and scope
projection_discuss in store.db                 -> projected discuss snapshots and source indexes
projection_jobs.diagnostics in store.db        -> projected job terminal diagnostics, including canonical usage summaries
~/.coral/exports/jobs/<jobId>/result.md        -> durable job result export (prod)
~/.coral/exports-dev/jobs/<jobId>/result.md    -> durable job result export (dev)
<os-tmpdir>/coral-jobs/<jobId>/                -> live job scratch artifacts
~/.coral/kb/ or ~/.coral/kb-dev/               -> KB markdown storage by flavor
~/.coral/data/kb/ or ~/.coral/data-dev/kb/     -> KB runtime artifacts, Orama/Needle projections, source-import staging
```

The important config distinction is simple: Coral is configured as a plugin plus hooks plus CLI-accessible bundles, and flavor-bearing state keeps prod and dev runtimes from reusing the wrong backend or KB data.
