# Configuration

Environment variables, plugin metadata, hooks, and flavor-aware runtime state for the current Coral runtime.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CORAL_CODEX_MODEL` | `gpt-5.5` | Default Codex model for new sessions |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CODEX_FAST` | _(none)_ | Codex service tier toggle. `1` = fast (priority), `0` = flex (cost-efficient). Any other non-blank value is rejected. Blank/unset falls back to `service_tier` in top-level `~/.codex/config.toml`, then Codex default. Env takes precedence over config.toml. Profile-scoped `service_tier` under `[profiles.xxx]` is ignored |
| `CORAL_CLAUDE_MODEL` | _(none)_ | Default model for the Claude sessions Coral launches. Either a tier alias (`opus`, `sonnet`, `haiku`), capped by `CORAL_CLAUDE_MODEL_CAP` (an alias above the cap is replaced by the cap tier), or a specific model id passed to Claude as-is — e.g. `opus[1m]` (the 1M-context Opus) or a full name like `claude-opus-4-8`; specific ids are not tier-capped. Unset/empty leaves the model unspecified so Claude uses its own default. An explicit per-request model wins. Mirrors `CORAL_CODEX_MODEL` (no built-in default) |
| `CORAL_CLAUDE_EFFORT` | `xhigh` | Claude reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Sonnet/Haiku have no `xhigh` level — the adapter collapses `xhigh` to the provider ceiling (`max`) on those tiers |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Maximum Claude model tier |
| `CORAL_EFFORT` | _(none)_ | Global effort fallback used only when the provider-specific `CORAL_{CLAUDE,CODEX}_EFFORT` is unset. Explicit request-body effort wins over all env vars |
| `CORAL_DEV_ASSERTIONS` | _(none)_ | Contributor-only developer assertions. Set `1` during local development or `npm test` to make stale continuity-bridge calls throw instead of silently no-oping, and to throw on dispatcher corrupt-state cases. Leave unset for production behavior; never enable in production deploys |
| `CORAL_MAX_WORKERS` | `10` | Max concurrent workers (1–10) |
| `CORAL_MAX_QUEUE_SIZE` | `20` | Max queued launches before Coral returns `busy` (1–1000) |
| `CORAL_DISCUSS_MAX_WORKERS` | `5` | Max concurrent discuss workers (1–10) |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Maximum discuss epochs |
| `CORAL_BACKEND_IDLE_MS` | `21600000` | Backend idle timeout in ms |
| `CORAL_JOBS_RETENTION_DAYS` | `14` | Days to keep a terminal job's export artifacts (`~/.coral/exports/jobs/<id>/result.md`) before backend startup prunes them. The export dir is a rebuildable cache of the journal — `result.md` is regenerated from the journal terminal event on the next read — so pruning only reclaims disk; `jobs list`/`detail` still resolve from the journal. Invalid/non-positive values fall back to the default |
| `CORAL_BACKEND_BIND` | `127.0.0.1` | Backend HTTP bind address. Loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) work without extra configuration; non-loopback binds such as `0.0.0.0` require `CORAL_BACKEND_ALLOW_REMOTE=1` |
| `CORAL_BACKEND_ALLOW_REMOTE` | _(none)_ | Explicit opt-in for non-loopback `CORAL_BACKEND_BIND` values. Set to `1` only when remote backend exposure is intentional and protected by a trusted network boundary |
| `CORAL_BACKEND_ADVERTISE_HOST` | _(bind value)_ | Hostname clients use to reach the backend. Distinct from `CORAL_BACKEND_BIND` when the bind interface differs from the externally reachable name (NAT, container host) |
| `CORAL_BROKER_IDLE_MS` | `300000` | Provider host (broker) idle eviction window in ms |
| `CORAL_BOOT_FRESHNESS_TIMEOUT_MS` | `90000` | Coordinator boot freshness wait (ms, the same `CONTENDER_BUDGET` used by lock acquisition). Lower for tighter integration test loops; rarely tuned in production |
| `CORAL_DISCOVERY_PROBE_CLK_TCK` | _(unset)_ | Linux-only debug gate. Set `1` to invoke `getconf CLK_TCK` instead of assuming the standard value of 100. Leave unset on every modern Linux |
| `CORAL_AUTO_SYMLINK` | `0` | Auto-create `.claude/coral` symlink on session start |
| `CORAL_FLAVOR` | `prod` when unset | Hook selector (`prod` or `dev`) for dev/prod coexistence. It controls which hooks fire, not daemon identity. For hooks, set it in Claude Code settings `env` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config dir, set by launching `claude` with it. Coral honors it: the backend daemon, socket, `store.db`, jobs, and KB runtime index isolate per config dir under `~/.coral/by-config/<slot>/`, so multiple Claude configs run independent daemons. The default maps to the unpartitioned `~/.coral` tree. See "Per-Config-Dir Isolation" below |
| `CORAL_KB_PATH` | `~/.coral/kb` (prod) / `~/.coral/kb-dev` (dev) | KB markdown-root override. Runtime KB state remains flavor-separated under `~/.coral/data/kb/` or `~/.coral/data-dev/kb/` |
| `CORAL_KB_IMPORT_MAX_BYTES` | `1073741824` (1 GiB) | Admin KB source-import cap in bytes, read from the backend daemon's environment at startup. `0` or `unlimited` disables the admin byte cap. Changing it requires exporting the var and restarting the backend daemon; setting it in an ad-hoc CLI shell does not affect an already-running daemon |
| `CORAL_KB_GIT_SYNC` | `0` | Enable KB git sync |
| `GEMINI_API_KEY` | _(none)_ | API key the Gemini embedding expansion reads when equipped (`coral-cli expansion equip gemini`) |

### Per-Config-Dir Isolation

A Claude Code plugin installs *inside* the config dir (`<CLAUDE_CONFIG_DIR>/plugins/...`), so two config dirs are two independent backend daemons. Coral partitions its daemon-owned runtime state — the coordinator socket/run dir, the journal `store.db`, job exports, engine artifacts, project memo trees, and the KB runtime index/journal — under `~/.coral/by-config/<slot>/`, where `<slot>` is an 8-char hash of the resolved config dir. Two Claude configs (e.g. `~/.claude` and `~/.claude-work`) therefore run fully isolated daemons that never share a socket or store. The default config dir (`~/.claude`) maps to no slot, keeping the historical `~/.coral` paths unchanged. The KB *markdown vault* (`~/.coral/kb`) stays shared across config dirs — only its rebuildable runtime index partitions. Design rationale: [design-rationale.md §5.4](design-rationale.md).

### HTTP Exposure

The default backend HTTP bind is loopback-only. If `CORAL_BACKEND_BIND` is set to a non-loopback address, Coral refuses to start unless `CORAL_BACKEND_ALLOW_REMOTE=1` is also set. Use that opt-in only behind a trusted reverse proxy or private network boundary, terminate TLS there, and protect the backend token as a bearer credential. Coral sets permissive CORS headers, including browser private-network preflight opt-in, for token-bearing clients; do not expose the port directly on an untrusted network.

### KB Source Imports

Source-import authority is interim and transport-derived: local IPC calls run as `admin`; HTTP calls run as `user`. The request body is not a trust signal. Admin imports, representing the local IPC owner, may read any file path the daemon account can read and use the admin size cap from `CORAL_KB_IMPORT_MAX_BYTES`, defaulting to 1 GiB. User imports are sandboxed to the project root and always have a fixed 128 MiB cap.

`CORAL_KB_IMPORT_MAX_BYTES` is a daemon-startup setting. The daemon reads it from its frozen runtime environment snapshot when it starts, so cap changes require exporting the variable in the daemon-startup environment and restarting the backend daemon. Setting `CORAL_KB_IMPORT_MAX_BYTES` ad hoc in a CLI shell does not affect an already-running daemon.

Real role-based auth (login / admin-vs-user tokens) is future work.

### Shell Usage

```bash
export CORAL_CODEX_MODEL=gpt-5.5
export CORAL_CODEX_EFFORT=high
export CORAL_DISCUSS_MAX_EPOCHS=3
export CORAL_KB_PATH=/path/to/my-kb
```

Unset `CORAL_FLAVOR` is treated as `prod`. Hooks use it only to decide whether the current hook bundle should run; daemon identity still comes from `bridge/manifest.json`. For local dev hooks, prefer the project `.claude/settings.local.json` `env` block over shell exports so Claude Code launches hooks with the intended flavor consistently.

### `.claude/settings.json`

Project-level or global Claude Code settings can persist the same environment variables:

```json
{
  "env": {
    "CORAL_CODEX_MODEL": "gpt-5.5",
    "CORAL_CODEX_FAST": "1",
    "CORAL_DISCUSS_MAX_EPOCHS": "3",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Changes to `settings.json` env take effect on the next Claude Code session start. `CORAL_CODEX_FAST` is re-read per Codex request via the `coralEnv` pipeline, so Coral backend restart is not required.

### Embedding credentials

Embedding credentials (e.g. `GEMINI_API_KEY`) are read from the backend's process environment. Set them in the user-level `~/.claude/settings.json` `env` block or your shell profile — not in repo-checked settings — then restart the backend (`coral-cli backend shutdown`; the next command relaunches it with the new environment).

## Config Files

### `.claude-plugin/plugin.json`

Claude Code plugin manifest. Relevant fields:

| Field | Purpose |
| --- | --- |
| `name` | Plugin name and slash-command prefix |
| `version` | Synced from `package.json` during build |
| `description` | Plugin description shown to the host |
| `author` / `repository` / `homepage` / `license` | Package metadata |
| `skills` | Relative path to the skill directory |

The manifest is limited to plugin metadata and the skill path. Transport registration is not part of the manifest.

### `bridge/manifest.json`

Build manifest written by `scripts/build-server.mjs`:

```json
{
  "bundleHash": "<backend-bundle-hash>",
  "flavor": "prod"
}
```

`bundleHash` tracks backend bundle bytes. `flavor` is the intrinsic build identity used by the backend and hooks to distinguish prod from dev.

### `hooks/hooks.json`

Hook registration for SessionStart, compact recovery, SubagentStart, PreCompact, PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, and Stop. See [Hooks](./hooks.md) for behavior details.

## Runtime State Files

### Backend state

| Path | Purpose |
| --- | --- |
| `~/.coral/run/coordinator.json` or `~/.coral/run-dev/coordinator.json` | Active coordinator discovery record |
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

| Package | Purpose |
| --- | --- |
| `zod` | Schema validation |
| `@orama/orama` | Base KB retrieval projection and fallback vector search |
| `graphology` | Graph data structures for KB community analysis |
| `graphology-communities-louvain` | Community detection |
| `mammoth` / `turndown` | Source import conversion |
| `@lydell/node-pty` | Interactive Claude CLI broker transport |
| `commander` | CLI command parsing (bundled into `bridge/coral-cli.cjs`) |
| `yaml` | YAML parsing |
| `zod-to-json-schema` | Schema export helpers |

## External Dependencies

| Tool | Purpose |
| --- | --- |
| Codex CLI | Codex execution |
| Claude CLI | Claude execution through the PTY broker helper |
| Node.js 22+ | Runtime |
| `cmake` | Native KB addon fallback builds |

## File Role Summary

```text
.claude-plugin/plugin.json                     -> plugin manifest
hooks/hooks.json                               -> hook registration
bridge/coral-backend.cjs                       -> backend daemon bundle
bridge/coral-cli.cjs                           -> CLI bundle
bridge/coral-claude-appserver.cjs              -> Claude PTY broker helper bundle
bridge/manifest.json                           -> backend bundle hash + build flavor

~/.coral/run*/coordinator.json                 -> active coordinator discovery record
~/.coral/run*/coordinator.lock                 -> per-flavor coordinator singleton lock
projection_sessions in store.db                -> projected provider session continuity and scope
projection_discuss in store.db                 -> projected discuss snapshots and source indexes
~/.coral/exports/jobs/<jobId>/result.md        -> durable job result export (prod)
~/.coral/exports-dev/jobs/<jobId>/result.md    -> durable job result export (dev)
<os-tmpdir>/coral-jobs/<jobId>/                -> live job scratch artifacts
~/.coral/kb/ or ~/.coral/kb-dev/               -> KB markdown storage by flavor
~/.coral/data/kb/ or ~/.coral/data-dev/kb/     -> KB runtime artifacts, Orama/Needle projections, source-import staging
```

The important config distinction is simple: Coral is configured as a plugin plus hooks plus CLI-accessible bundles, and flavor-bearing state keeps prod and dev runtimes from reusing the wrong backend or KB data.
