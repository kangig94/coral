# Configuration

Environment variables, plugin metadata, hooks, and flavor-aware runtime state for the current Coral runtime.

## Environment Variables

| Variable                              | Default                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORAL_CODEX_MODEL`                   | `gpt-5.6-sol`                                  | Default Codex model for new sessions when no request/agent model is set. When this baseline is a GPT-5.6 family id (`gpt-5.6*`, or bare `sol`/`terra`/`luna`), agent abstract tiers map as `opus`→`sol`, `sonnet`→`terra`, `haiku`→`luna`. For older single-size lines (e.g. `gpt-5.5`) there is no size split — abstract tiers all use this baseline. Concrete model ids pass through unchanged                                                                                                                                                                                    |
| `CORAL_CODEX_EFFORT`                  | `high`                                         | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Ceilings: Sol/Terra `ultra`, Luna `max` (no ultra), older lines e.g. `gpt-5.5` `xhigh`. Terra/Luna also floor anything below `xhigh` to `xhigh`                                                                                                                                                                                                                                                                                                                                                          |
| `CORAL_CODEX_FAST`                    | _(none)_                                       | Codex fast-mode toggle. `1` = fast (priority), `0` = explicit `default` (fast off). Any other non-blank value is rejected. Blank/unset falls back to `service_tier` (`default`, `fast`, or `flex`) in top-level `~/.codex/config.toml`, then Codex default. Env takes precedence over config.toml. Profile-scoped `service_tier` under `[profiles.xxx]` is ignored                                                                                                                                                                                                                  |
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
| `CLAUDE_CONFIG_DIR`                   | `~/.claude`                                    | Claude Code's config dir, set by launching `claude` with it. Coral honors it: the backend daemon, socket, `store.db`, jobs, and KB runtime index isolate per config dir under `~/.coral/by-config/<slot>/`, so multiple Claude configs run independent daemons. The default maps to the unpartitioned `~/.coral` tree. See "Per-Config-Dir Isolation" below                                                                                                                                                                                                                         |
| `CORAL_KB_PATH`                       | `~/.coral/kb` (prod) / `~/.coral/kb-dev` (dev) | KB markdown-root override. Runtime KB state remains flavor-separated under `~/.coral/data/kb/` or `~/.coral/data-dev/kb/`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CORAL_KB_IMPORT_MAX_BYTES`           | `1073741824` (1 GiB)                           | Admin KB source-import cap in bytes, read from the backend daemon's environment at startup. `0` or `unlimited` disables the admin byte cap. Changing it requires exporting the var and restarting the backend daemon; setting it in an ad-hoc CLI shell does not affect an already-running daemon                                                                                                                                                                                                                                                                                   |
| `CORAL_KB_GIT_SYNC`                   | `0`                                            | Enable KB git sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CORAL_KB_ENABLE`                     | _(unset → enabled)_                            | Set `0` to boot the daemon without spawning the KB daemon — no corpus indexing, curate, retrieval, or KB content injected into sessions/agents. `1` or unset enables it; a malformed value warns once and leaves KB enabled. Read from the daemon's environment at startup like `CORAL_KB_IMPORT_MAX_BYTES`. Flipping `0`→`1` and running any `kb …` command transparently restarts the daemon to bring KB online (that one command waits for daemon-ready; KB daemon boot remains non-blocking)                                                                                    |
| `GEMINI_API_KEY`                      | _(none)_                                       | API key the Gemini embedding expansion reads when equipped (`coral-cli expansion equip gemini`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Per-Config-Dir Isolation

A Claude Code plugin installs _inside_ the config dir (`<CLAUDE_CONFIG_DIR>/plugins/...`), so two config dirs are two independent backend daemons. Coral partitions its daemon-owned runtime state — the coordinator socket/run dir, the journal `store.db`, job exports, engine artifacts, project memo trees, and the KB runtime index/journal — under `~/.coral/by-config/<slot>/`, where `<slot>` is an 8-char hash of the resolved config dir. Two Claude configs (e.g. `~/.claude` and `~/.claude-work`) therefore run fully isolated daemons that never share a socket or store. The default config dir (`~/.claude`) maps to no slot, keeping the historical `~/.coral` paths unchanged. The KB _markdown vault_ (`~/.coral/kb`) stays shared across config dirs — only its rebuildable runtime index partitions. Design rationale: [design-rationale.md §5.4](design-rationale.md).

### HTTP Exposure

The default backend HTTP bind is loopback-only. If `CORAL_BACKEND_BIND` is set to a non-loopback address, Coral refuses to start unless `CORAL_BACKEND_ALLOW_REMOTE=1` is set and a remote access policy is configured. Prefer `CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST` with exact trusted client IPs. `CORAL_BACKEND_REMOTE_UNRESTRICTED=1` keeps token-only access available for deployments that enforce access outside Coral, but it emits a warning audit event and should only be used behind a trusted reverse proxy or private network boundary. Coral grants browser CORS only to loopback origins; non-browser clients still authenticate with the backend token.

### Proxy and TLS Forwarding

The backend is a long-lived shared daemon whose environment is frozen at boot, so a proxy or CA bundle exported in the invoking shell _after_ the daemon started would never reach a spawned provider. Coral therefore forwards the caller shell's network env on every provider launch (`coral-cli claude`/`codex`, workflow, discuss): `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `FTP_PROXY` (upper- and lower-case), and `NODE_EXTRA_CA_CERTS`. Non-empty values are forwarded verbatim as real environment variables on the `claude`/`codex` broker child; an exported-but-empty variable is omitted so it does not shadow the daemon's own setting. This set is fixed and not user-configurable; volatile per-terminal variables are deliberately excluded so broker identity stays stable across turns.

The forwarded env participates in provider reuse decisions, so a changed proxy re-establishes provider state rather than silently reusing a stale one — but the providers differ in mechanism. Codex carries this env in its provider-server spec, so a different proxy keys a distinct Codex broker process. Claude carries only `CORAL_CLAUDE_TRANSPORT` in its provider-server spec; network env enters the Claude session env hash, and a mismatch forces a fresh session bootstrap on that broker rather than a new broker process.

### Session Config Forwarding

The provider config the daemon resolves _per request_ — the model/effort/transport knobs `CORAL_CODEX_MODEL`, `CORAL_CODEX_EFFORT`, `CORAL_CODEX_FAST`, `CORAL_CLAUDE_MODEL`, `CORAL_CLAUDE_MODEL_CAP`, `CORAL_CLAUDE_EFFORT`, `CORAL_CLAUDE_TRANSPORT`, `CORAL_EFFORT`, plus the owner-attribution fallback `CORAL_OWNER` — is also frozen in the long-lived daemon at boot. Because the `coral-cli` process Claude Code launches for each invocation already carries the current `settings.json` env, Coral forwards the caller's full `CORAL_*` config on every provider launch (and KB mutation) as an **authoritative** `coralEnv` map: the caller's value wins over the daemon's boot value, and a key the caller _unset_ is absent — so the provider falls back to its code default (e.g. removing `CORAL_CODEX_MODEL` from `settings.json` reverts new Codex sessions to `gpt-5.6-sol`). A change to one of these variables therefore reaches a spawned provider on the next `coral-cli` invocation **run in a session started after the edit** (see [`.claude/settings.json`](#claudesettingsjson) below — env is fixed onto the Claude Code process at session start), with **no backend restart** on top of that.

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
  "flavor": "prod"
}
```

`bundleHash` tracks backend bundle bytes. `flavor` is the intrinsic build identity used by the backend and hooks to distinguish prod from dev.

### `clients/hooks/claude.json` and `clients/hooks/codex.json`

Per-client hook registration, each referenced by its own `plugin.json` (`.claude-plugin` → `./hooks/claude.json`, `.codex-plugin` → `./hooks/codex.json`). `claude.json` is the full set (SessionStart, compact recovery, SubagentStart, PreCompact, PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop); `codex.json` is the same minus the Claude-only hooks (`hud-auto-update`, the `SubagentStart`/`SubagentStop` scripts, and the `PreToolUse(Monitor)` guard). See [Hooks](./hooks.md) for behavior details.

## Runtime State Files

### Backend state

| Path                                                                   | Purpose                               |
| ---------------------------------------------------------------------- | ------------------------------------- |
| `~/.coral/run/coordinator.json` or `~/.coral/run-dev/coordinator.json` | Active coordinator discovery record   |
| `~/.coral/run/coordinator.lock` or `~/.coral/run-dev/coordinator.lock` | Per-flavor singleton coordinator lock |

### Session state

Sessions are Journal events projected into `projection_sessions`. `SessionManager` scopes lookups with `scope_key`, derived from the project root namespace; it no longer owns JSON session files.

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
