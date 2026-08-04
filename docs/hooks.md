# Hooks

Hooks provide automatic context injection, backend warm-start, compaction recovery, KB reminders, CLI path resolution, prompt-mode Ralph looping, and flavor-aware self-gating.

## Overview

Hook registration is split per client, each `plugin.json` pointing at its own file: `clients/hooks/claude.json` (Claude Code — the full set below, via `.claude-plugin/plugin.json` `"hooks": "./hooks/claude.json"`) and `clients/hooks/codex.json` (Codex — the same set minus `hud-auto-update`, the `SubagentStart`/`SubagentStop` scripts, and the `PreToolUse(Monitor)` tracker, via `.codex-plugin/plugin.json` `"hooks": "./hooks/codex.json"`). The hook scripts themselves are shared; `codex.json` invokes them through Codex's native `${PLUGIN_ROOT}`, while `claude.json` uses `${CLAUDE_PLUGIN_ROOT}`. (Codex also exports `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as OOTB compat aliases of its native `PLUGIN_ROOT`/`PLUGIN_DATA`, so the shared scripts — which read `CLAUDE_PLUGIN_ROOT` internally — run unchanged under both clients.) Coral uses these Claude Code hook events:

| Event                      | Scripts                                                                                 | Purpose                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SessionStart` (`*`)       | `session-start.mjs`, `hud-auto-update.mjs`                                              | Inject the shared fragment bundle (and spawn the backend daemon — absorbed from the former `backend-warm-start.mjs`), refresh HUD |
| `SessionStart` (`compact`) | `kb-promote-gate.mjs`, `post-compact.mjs`                                               | Restore KB/promotion guidance and recover active jobs after compaction                                             |
| `SubagentStart`            | `subagent-start.mjs`                                                                    | Inject the subagent-safe fragment bundle                                                                          |
| `PreCompact`               | `pre-compact.mjs`                                                                       | Snapshot active jobs before compaction                                                                             |
| `UserPromptSubmit`         | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `kb-memo-reminder.mjs`, `coral-skill-vars.mjs` | KB flags, Ralph loop state, memo reminders, skill vars                                                             |
| `PreToolUse` (`Skill`)     | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `coral-skill-vars.mjs`                         | Same state setup for skill-initiated flows                                                                         |
| `PreToolUse` (`Bash`)      | `bash-rewrite.mjs`                                                                       | Resolve `coral-cli` calls + wrap `run_in_background` for lifecycle tracking                                                          |
| `PreToolUse` (`Monitor`)   | `monitor-track.mjs`                                                                      | Wrap the Monitor command for lifecycle tracking (skips ws + persistent monitors)                                    |
| `PostToolUseFailure`       | `kb-lookup-reminder.mjs`                                                                | KB reminder on explicit tool failures                                                                              |
| `PostToolUse` (`Bash`)     | `kb-lookup-reminder.mjs`                                                                | KB reminder on silent-failure command output                                                                       |
| `Stop`                     | `ralph-loop.mjs`, `kb-promote-gate.mjs`                                                 | Prompt-mode looping and KB promotion enforcement                                                                   |

All hook scripts are Node.js ESM files that read JSON from stdin, write JSON to stdout, and fail open.

## Hook Self-Gating

All shipped hook entrypoints run `exitIfChildProcess()` first and `exitIfWrongFlavor()` second. `exitIfChildProcess()` suppresses Coral child-process reentry. `exitIfWrongFlavor()` compares `CORAL_FLAVOR` (unset => `prod`) with the hook bundle's own `bridge/manifest.json` flavor, exits `0` on mismatch, and exits `1` with stderr for unrecognized values. This is what allows marketplace prod hooks and locally registered dev hooks to coexist without cross-firing.

The HUD auto-update hook adds one more gate: it refreshes the HUD only when `buildFlavor() === 'prod'`, so dev registrations never overwrite the prod HUD.

## Inject bundle (shared guidelines)

The `clients/inject/` directory separates behavioral guidelines, tools, and audience-scoped KB guidance:

| Fragment | Role |
| --- | --- |
| `core.md` | Shared behavioral guidelines |
| `tools.md` | CLI, path aliases, and the live equipped-tools placeholder |
| `kb/common.md` | KB search and verification guidance |
| `kb/orchestrator.md` | Top-level owner propagation, wiki maintenance, and source management |
| `kb/session.md` | Session-scoped memo, promotion, update, and invalidation guidance |

Renderers select fragments explicitly for each surface. There is no conditional-block markup inside the Markdown files.

### Delivery paths

| Surface | Mechanism | When |
| --- | --- | --- |
| Host Claude main session | `session-start.mjs` → `renderInject` (`asOwner: true`) | `SessionStart` |
| Claude Code native subagent (`Agent` tool) | `subagent-start.mjs` → `renderInject` (`asOwner: false`) | `SubagentStart` |
| Provider child (`coral-cli codex\|claude`, workflow atoms, discuss jobs) | `jobs/shell/launch.ts` → `applyInjectBundle` → `resolveInjectBundle` | Every job `executeJob` |

Provider children set `CORAL_CHILD=1`, so hooks self-exit and **do not** re-inject. Adapters must not re-resolve the bundle; they consume the pre-merged `request.systemPrompt` (Claude: `--append-system-prompt`; Codex: turn-text prefix — presentation order only, not a separate system channel).

### Placeholders

| Placeholder | Meaning |
| --- | --- |
| `{{CORAL_CLI}}` | Plugin-local CLI invocation (`node "…/bridge/coral-cli.cjs"` or hook active-bridge form) |
| `{{CORAL_METHODS}}` | Absolute `…/methods/` (trailing slash). Always filled from plugin root. |
| `{{CORAL_PROJECT}}` | Project data dir (`~/.coral/projects/{slug}/…`). Left as placeholder if no project cwd. |
| `{{CORAL_PROJECTS}}` | Same value as `{{CORAL_PROJECT}}` (legacy plural form) |
| `{{PROJECT_SOURCE}}` | Project source label for the cwd |
| `{{CORAL_KB}}` | KB root |
| `{{SESSION_ID}}` | Owner session id when known |
| `{{EQUIPPED_TOOLS}}` | Live `/equip` tool list, or empty |

Path aliases in `tools.md` teach agents to open `CORAL_METHODS/HOW-*.md` and `CORAL_PROJECT/plans/…` via the resolved absolute paths rather than inventing marketplace/cache paths.

### Fragment composition

| Fragment | SessionStart (`asOwner: true`) | SubagentStart (`asOwner: false`) | Owned provider | Anonymous provider | KB disabled |
| --- | --- | --- | --- | --- | --- |
| `core.md` | included | included | included | included | included |
| `tools.md` | included | included | included | included | included |
| `kb/common.md` | included | included | included | included | omitted |
| `kb/orchestrator.md` | included | omitted | omitted | omitted | omitted |
| `kb/session.md` | included | included | included | omitted | omitted |

Orchestrator content is limited to the top-level host session. Provider children receive session guidance only when a valid `CORAL_OWNER` identifies the shared session.

### Equipped tools

The `tools.md` fragment's `{{EQUIPPED_TOOLS}}` placeholder lists agent-facing tools Coral ships `/equip` support for and that are currently installed. `clients/hooks/lib/equip-tools.mjs` holds the catalog; `resolveEquippedTools()` does a **live** filesystem probe under the engine data tree. Session-start and subagent-start both pass the live list; provider jobs pass the same list through `ProviderRuntime.equippedTools`. When the list is empty, the placeholder is stripped.

### Skill path vars

`coral-skill-vars.mjs` still injects short `CORAL_PROJECT:` / `CORAL_METHODS:` lines on skill-related `UserPromptSubmit` / `PreToolUse(Skill)` for host skill protocols. Those aliases are also present in `tools.md` for every inject surface above, so provider children and Claude-native subagents do not depend on the skill hook.

## SessionStart

`clients/hooks/session-start.mjs` renders the fragment bundle via `renderInject({ asOwner: true })` and returns it through `hookSpecificOutput.additionalContext`.

KB wake-up reads no runtime database. `readProjectScopedWakeUp()` reads the project wiki directly from the configured Markdown KB root and fails open with `null` on missing or malformed content. The separate PreCompact snapshot hook mirrors the canonical store path as `~/.coral/gen2/data/store/store.db` or `~/.coral/gen2/data-dev/store/store.db`; it validates the installed fingerprint before opening that projection read-only.

Hook SQLite access goes through the supported Node runtime's built-in `node:sqlite` module. Missing or unreadable snapshot data fails open instead of breaking hook startup.

It also:

- adds `Bash(node *coral-cli*)` permission to `.claude/settings.local.json`
- on every valid project SessionStart, migrates Coral's exact legacy project entry from the Git-root `.gitignore` into `.claude/.gitignore`; this is independent of `CORAL_AUTO_SYMLINK`
- when `CORAL_AUTO_SYMLINK=1`, ensures the scoped ignore first and then creates `.claude/coral -> ~/.coral/projects/{slug}/`
- runs ignore maintenance in a time-bounded child process; unsafe, oversized, changed-during-write, or non-regular ignore paths fail closed without removing legacy protection
- refreshes the HUD only for prod builds; `hud-auto-update.mjs` exits early for dev flavor even if the hook is registered locally

## Backend Warm-start

`clients/hooks/session-start.mjs` unconditionally spawns `bridge/coral-backend.cjs` near the top of its body (logic absorbed from the former `backend-warm-start.mjs`). The daemon's `bindWithHandoff` / `requestIncumbentShutdown` contention layer is the single source of truth for staleness: a healthy same-bundle peer makes the new daemon throw `BackendAlreadyRunningError` and exit; a mismatching peer triggers IPC `transport.shutdown` and the new daemon takes over the bound socket. The hook stays free of bundle/flavor comparison so the contention contract has one canonical home. Failures are ignored and the CLI can start the backend lazily later.

## Compact Recovery

Two hooks run after compaction:

- `kb-promote-gate.mjs` restores memo-review and KB-promotion guidance
- `pre-compact.mjs` snapshots recent jobs for the current project from `projection_jobs`
- `post-compact.mjs` reads that snapshot and tells the user how to recover work

`post-compact.mjs` now describes recovery in CLI terms:

- pending jobs: `coral-cli wait jobs <job-id...>`
- terminal jobs without inline artifacts: `coral-cli wait jobs <job> --embed`
- missing or unreadable job state: do not rerun `wait` unless a verified artifact path exists

`wait jobs` exits `0` when every job completed successfully, `1` for a failed, aborted, or faulted job, and with the normalized child code for `provider_exit`. Exit `75` is not a job failure: work is still running, and recovery should resume with the printed cursor.

Implementation notes:

- snapshots are written under the project temp directory (`/tmp/claude-<uid>/coral/<project-slug>/hooks/active-jobs-*.json`)
- terminal recovery uses the durable artifact path under `~/.coral/exports/jobs/<jobId>/result.md` in prod or `~/.coral/exports-dev/jobs/<jobId>/result.md` in dev
- `<os-tmpdir>/coral-jobs/<jobId>/` contains live scratch artifacts such as stdout/stderr/intermediates only
- hook recovery reads CLI-visible job state and durable result artifacts, not file-backed job status records

The wait guidance matches the current CLI contract: terminal text always includes `Result path: <path>`, may include a terminal-line usage segment from job diagnostics, and `--embed` preview text is only a convenience layer. Read the printed result path for the durable artifact.

## SubagentStart

Two different “subagent” concepts must not be mixed:

| Kind | What it is | Inject path |
| --- | --- | --- |
| Claude Code native subagent | Host `Agent` tool spawn | `SubagentStart` → `subagent-start.mjs` |
| Coral provider agent | `coral-cli codex\|claude <agent>`, workflow atom, discuss worker | **No hooks** (`CORAL_CHILD=1`); `applyInjectBundle` in the job shell |

`clients/hooks/subagent-start.mjs` covers only the first kind. It calls `renderInject({ asOwner: false })`, which composes `core.md`, `tools.md`, `kb/common.md`, and `kb/session.md` when KB is enabled. It omits `kb/orchestrator.md`, while retaining session guidance because subagents share the parent session id for memo scope. `subagent-track.mjs` records live markers for Ralph / promote-gate deferral; it does not inject text.

## UserPromptSubmit and PreToolUse

These hooks set up runtime state for KB-producing skills and prompt-mode Ralph:

- `kb-promote-gate.mjs` creates session-scoped KB activity flags
- `ralph-loop.mjs` creates or updates the prompt-loop state file
- `coral-skill-vars.mjs` injects short `CORAL_PROJECT` / `CORAL_METHODS` lines for host skill flows (aliases also live in `inject/tools.md` for all inject surfaces)
- `bash-rewrite.mjs` rewrites bare `coral-cli` Bash commands to the plugin-local CLI bundle path, and wraps `run_in_background` commands so they record start / liveness / exit in the live-work registry (`lib/live-work-registry.mjs`)

## Failure-aware KB Reminder

`clients/hooks/kb-lookup-reminder.mjs` covers two cases:

- `PostToolUseFailure`: explicit non-zero tool exits
- `PostToolUse` on Bash: silent failures where the shell command returned zero but emitted known failure patterns

In both cases the hook injects additional KB lookup guidance without blocking the session.

## Stop Hooks

Two stop-time guards can block session exit:

- `ralph-loop.mjs` re-injects the stored prompt when prompt-mode Ralph should continue
- `kb-promote-gate.mjs` forces a memo review / promotion pass for KB-producing sessions

These hooks coexist because Claude Code can honor multiple `decision: "block"` responses during the same stop cycle.

## Node.js ESM Conventions

Hook scripts follow the same shape:

```javascript
import { exitIfChildProcess, exitIfWrongFlavor } from './lib/hook-utils.mjs';
import { readFileSync } from 'node:fs';

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  const output = {
    /* hook result */
  };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch {
  process.exit(0);
}
```

Rules:

- use ESM (`.mjs`, `import`)
- read stdin JSON
- write machine-readable JSON to stdout
- fail open on any exception
- avoid external runtime dependencies except documented hook-local fallbacks such as the read-only `better-sqlite3` corpus snapshot reader
