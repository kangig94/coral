# Hooks

Hooks provide automatic context injection, backend warm-start, compaction recovery, KB reminders, CLI path resolution, prompt-mode Ralph looping, and flavor-aware self-gating.

## Overview

Hook registration lives in `clients/hooks/hooks.json`. Coral uses these Claude Code hook events:

| Event                      | Scripts                                                                                 | Purpose                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SessionStart` (`*`)       | `session-start.mjs`, `hud-auto-update.mjs`                                              | Inject `INJECT.md` (and spawn the backend daemon — absorbed from the former `backend-warm-start.mjs`), refresh HUD |
| `SessionStart` (`compact`) | `kb-promote-gate.mjs`, `post-compact.mjs`                                               | Restore KB/promotion guidance and recover active jobs after compaction                                             |
| `SubagentStart`            | `subagent-start.mjs`                                                                    | Inject subagent-safe `INJECT.md`                                                                                   |
| `PreCompact`               | `pre-compact.mjs`                                                                       | Snapshot active jobs before compaction                                                                             |
| `UserPromptSubmit`         | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `kb-memo-reminder.mjs`, `coral-skill-vars.mjs` | KB flags, Ralph loop state, memo reminders, skill vars                                                             |
| `PreToolUse` (`Skill`)     | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `coral-skill-vars.mjs`                         | Same state setup for skill-initiated flows                                                                         |
| `PreToolUse` (`Bash`)      | `cli-resolve.mjs`                                                                       | Resolve bare `coral-cli` calls to the plugin-local bundle                                                          |
| `PreToolUse` (`Monitor`)   | `cli-monitor-guard.mjs`                                                                 | Guard Monitor tool calls                                                                                           |
| `PostToolUseFailure`       | `kb-lookup-reminder.mjs`                                                                | KB reminder on explicit tool failures                                                                              |
| `PostToolUse` (`Bash`)     | `kb-lookup-reminder.mjs`                                                                | KB reminder on silent-failure command output                                                                       |
| `Stop`                     | `ralph-loop.mjs`, `kb-promote-gate.mjs`                                                 | Prompt-mode looping and KB promotion enforcement                                                                   |

All hook scripts are Node.js ESM files that read JSON from stdin, write JSON to stdout, and fail open.

## Hook Self-Gating

All shipped hook entrypoints run `exitIfChildProcess()` first and `exitIfWrongFlavor()` second. `exitIfChildProcess()` suppresses Coral child-process reentry. `exitIfWrongFlavor()` compares `CORAL_FLAVOR` (unset => `prod`) with the hook bundle's own `bridge/manifest.json` flavor, exits `0` on mismatch, and exits `1` with stderr for unrecognized values. This is what allows marketplace prod hooks and locally registered dev hooks to coexist without cross-firing.

The HUD auto-update hook adds one more gate: it refreshes the HUD only when `buildFlavor() === 'prod'`, so dev registrations never overwrite the prod HUD.

## INJECT.md (shared guidelines)

`INJECT.md` is the single source of behavioral guidelines, Tools section, path aliases, and optional KB guidance. Delivery differs by surface; the file does not.

### Delivery paths

| Surface | Mechanism | When |
| --- | --- | --- |
| Host Claude main session | `session-start.mjs` → `renderInject` (`asOwner: true`) | `SessionStart` |
| Claude Code native subagent (`Agent` tool) | `subagent-start.mjs` → `renderInject` (`asOwner: false`) | `SubagentStart` |
| Provider child (`coral-cli codex\|claude`, workflow atoms, discuss jobs) | `jobs/shell/launch.ts` → `applyInjectMd` → `resolveInjectMd` | Every job `executeJob` |

Provider children set `CORAL_CHILD=1`, so hooks self-exit and **do not** re-inject. Adapters must not re-resolve `INJECT.md`; they consume the pre-merged `request.systemPrompt` (Claude: `--append-system-prompt`; Codex: turn-text prefix — presentation order only, not a separate system channel).

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

Path aliases under `# Tools` teach agents to open `CORAL_METHODS/HOW-*.md` and `CORAL_PROJECT/plans/…` via the resolved absolute paths rather than inventing marketplace/cache paths.

### Conditional blocks

| Block | SessionStart (`asOwner: true`) | SubagentStart (`asOwner: false`) | Provider `resolveInjectMd` |
| --- | --- | --- | --- |
| `OWNER_ONLY` | kept | stripped | always stripped |
| `SESSION_ID_ONLY` | kept when session id present | kept (same parent session) | kept only when a valid owner session id is present |
| `KB_ONLY` | kept when KB enabled | kept when KB enabled | kept when KB enabled |

Owner-only content is orchestrator privilege (e.g. wiki maintenance, source import, `owner:` propagation). Subagents and provider children do not receive it.

### Equipped tools

The `# Tools` section's `{{EQUIPPED_TOOLS}}` placeholder lists agent-facing tools Coral ships `/equip` support for and that are currently installed. `clients/hooks/lib/equip-tools.mjs` holds the catalog; `resolveEquippedTools()` does a **live** filesystem probe under the engine data tree. Session-start and subagent-start both pass the live list; provider jobs pass the same list through `ProviderRuntime.equippedTools`. When the list is empty, the placeholder is stripped.

### Skill path vars

`coral-skill-vars.mjs` still injects short `CORAL_PROJECT:` / `CORAL_METHODS:` lines on skill-related `UserPromptSubmit` / `PreToolUse(Skill)` for host skill protocols. Those aliases are also present in `INJECT.md` for every inject surface above, so provider children and Claude-native subagents do not depend on the skill hook.

## SessionStart

`clients/hooks/session-start.mjs` renders `INJECT.md` via `renderInject({ asOwner: true })` and returns it through `hookSpecificOutput.additionalContext`.

KB wake-up cache support uses hook-local path helpers only: `kbRuntimeDir(flavor)` resolves `~/.coral/data/kb` or `~/.coral/data-dev/kb`, while `storeDbPath(flavor)` resolves the separate backend store DB at `~/.coral/data/store/store.db` or `~/.coral/data-dev/store/store.db`. The snapshot reader opens `kb_corpus_state` read-only from the store DB path, or from the sibling store DB when given a KB runtime dir, and fails open with `null` on any error.

Hook SQLite access goes through the supported Node runtime's built-in `node:sqlite` module. Missing or unreadable snapshot data fails open instead of breaking hook startup.

It also:

- adds `Bash(node *coral-cli*)` permission to `.claude/settings.local.json`
- optionally creates `.claude/coral -> ~/.coral/projects/{slug}/` when `CORAL_AUTO_SYMLINK=1`
- updates `.gitignore` for generated local files when Coral creates them
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

Implementation notes:

- snapshots are written under the project temp directory (`/tmp/coral/<project-slug>/hooks/active-jobs-*.json`)
- terminal recovery uses the durable artifact path under `~/.coral/exports/jobs/<jobId>/result.md` in prod or `~/.coral/exports-dev/jobs/<jobId>/result.md` in dev
- `<os-tmpdir>/coral-jobs/<jobId>/` contains live scratch artifacts such as stdout/stderr/intermediates only
- hook recovery reads CLI-visible job state and durable result artifacts, not file-backed job status records

The wait guidance matches the current CLI contract: terminal text always includes `Result path: <path>`, may include a terminal-line usage segment from job diagnostics, and `--embed` preview text is only a convenience layer. Read the printed result path for the durable artifact.

## SubagentStart

Two different “subagent” concepts must not be mixed:

| Kind | What it is | Inject path |
| --- | --- | --- |
| Claude Code native subagent | Host `Agent` tool spawn | `SubagentStart` → `subagent-start.mjs` |
| Coral provider agent | `coral-cli codex\|claude <agent>`, workflow atom, discuss worker | **No hooks** (`CORAL_CHILD=1`); `applyInjectMd` in the job shell |

`clients/hooks/subagent-start.mjs` covers only the first kind. It calls `renderInject({ asOwner: false })`: same `INJECT.md` as the main session (guidelines, Tools, path aliases, equipped tools, KB guidance when enabled), but **OWNER_ONLY stripped**. `SESSION_ID_ONLY` is kept so subagents share the parent session id for memo scope. `subagent-track.mjs` records live markers for Ralph / promote-gate deferral; it does not inject text.

## UserPromptSubmit and PreToolUse

These hooks set up runtime state for KB-producing skills and prompt-mode Ralph:

- `kb-promote-gate.mjs` creates session-scoped KB activity flags
- `ralph-loop.mjs` creates or updates the prompt-loop state file
- `coral-skill-vars.mjs` injects short `CORAL_PROJECT` / `CORAL_METHODS` lines for host skill flows (aliases also live in `INJECT.md` for all inject surfaces)
- `cli-resolve.mjs` rewrites bare `coral-cli` Bash commands to the plugin-local CLI bundle path

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
