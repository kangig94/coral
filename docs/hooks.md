# Hooks

Hooks provide automatic context injection, backend warm-start, compaction recovery, KB reminders, CLI path resolution, prompt-mode Ralph looping, and flavor-aware self-gating.

## Overview

Hook registration is split per client, each `plugin.json` pointing at its own file: `clients/hooks/claude.json` (Claude Code — the full set below, via `.claude-plugin/plugin.json` `"hooks": "./hooks/claude.json"`), `clients/hooks/codex.json` (Codex — the same set minus `hud-auto-update`, the `SubagentStart`/`SubagentStop` scripts, and the `PreToolUse(Monitor)` tracker, via `.codex-plugin/plugin.json` `"hooks": "./hooks/codex.json"`), and `clients/hooks/copilot.json` (Copilot CLI — the same set minus `hud-auto-update`, the `PreToolUse(Monitor)` tracker, and the compaction plus subagent hooks, via `.github/plugin/plugin.json` `"hooks": "./hooks/copilot.json"`; see the contract deltas below for the registration-shape differences). The hook scripts themselves are shared; `codex.json` invokes them through Codex's native `${PLUGIN_ROOT}`, while `claude.json` and `copilot.json` use `${CLAUDE_PLUGIN_ROOT}`. (Codex and Copilot both export `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as OOTB compat aliases of their native plugin-root variables, so the shared scripts — which read `CLAUDE_PLUGIN_ROOT` internally — run unchanged under all three clients.) Coral uses these Claude Code hook events:

| Event                      | Scripts                                                                                 | Purpose                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` (`*`)       | `session-start.mjs`, `kb-start.mjs`, `hud-auto-update.mjs`                              | Inject bounded base and KB payloads, spawn the backend daemon, refresh HUD                                                       |
| `SessionStart` (`compact`) | `kb-promote-gate.mjs`, `post-compact.mjs`                                               | Restore KB/promotion guidance and recover active jobs after compaction                                                            |
| `SubagentStart`            | `subagent-start.mjs`, `kb-start.mjs`                                                    | Inject bounded base and subagent-safe KB payloads                                                                                  |
| `PreCompact`               | `pre-compact.mjs`                                                                       | Snapshot active jobs before compaction                                                                                            |
| `UserPromptSubmit`         | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `kb-memo-reminder.mjs`, `coral-skill-vars.mjs` | KB flags, Ralph loop state, memo reminders, skill vars                                                                            |
| `PreToolUse` (`Skill`)     | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `coral-skill-vars.mjs`                         | Same state setup for skill-initiated flows                                                                                        |
| `PreToolUse` (`Bash`)      | `bash-rewrite.mjs`                                                                      | Resolve `coral-cli` calls + wrap `run_in_background` for lifecycle tracking                                                       |
| `PreToolUse` (`Monitor`)   | `monitor-track.mjs`                                                                     | Wrap the Monitor command for lifecycle tracking (skips ws + persistent monitors)                                                  |
| `PostToolUseFailure`       | `kb-lookup-reminder.mjs`                                                                | KB reminder on explicit tool failures                                                                                             |
| `PostToolUse` (`Bash`)     | `kb-lookup-reminder.mjs`                                                                | KB reminder on silent-failure command output                                                                                      |
| `Stop`                     | `ralph-loop.mjs`, `kb-promote-gate.mjs`                                                 | Prompt-mode looping and KB promotion enforcement                                                                                  |

All hook scripts are Node.js ESM files that read JSON from stdin, write JSON to stdout, and fail open.

## Copilot CLI contract deltas

Copilot reuses Claude Code's hook vocabulary, but six details differ. All were verified against Copilot CLI 1.0.78.

**Manifest precedence.** Copilot resolves `.github/plugin/plugin.json` before `.claude-plugin/plugin.json` (and never reads `.codex-plugin/`). That is the only reason Copilot loads `copilot.json` rather than Claude's `claude.json` — deleting `clients/.github/plugin/` would silently hand Copilot the Claude registration.

**Output envelope.** Claude Code and Codex namespace per-event fields under `hookSpecificOutput`. Copilot is *split*, and the split was A/B-verified in both directions: it reads `additionalContext` only at the **top level** (a wrapped one never reaches the model), but reads `permissionDecision` / `permissionDecisionReason` / `updatedInput` only **inside the envelope** (a flat `updatedInput` never rewrites the command). Hook scripts therefore emit one canonical Claude-shaped payload through `writeHookOutput()` (`clients/hooks/lib/hook-utils.mjs`), which hoists exactly the fields listed in `COPILOT_HOISTED_FIELDS` and leaves the rest enveloped. Already-flat shapes pass through untouched: Copilot honors Stop-hook `decision: 'block'` with `reason` in exactly Claude's form (verified — a blocked turn continues with `reason` as its instruction), so the ralph loop and the KB Stop gate work unchanged. A new enveloped field is top-level-only until proven otherwise — add it to `COPILOT_HOISTED_FIELDS` only after an A/B check.

**Event names.** Copilot fires both its native camelCase event (`sessionStart`) and the PascalCase Claude alias (`SessionStart`) for the same underlying event, so registering both would run every hook twice. `copilot.json` registers only the PascalCase names — which additionally makes Copilot deliver Claude's snake_case payload (`session_id`, `tool_name`, `tool_input`), the shape the shared scripts already parse.

**Matchers and tool names.** Under PascalCase events Copilot maps its native tool names onto Claude's where an equivalent exists (`bash` → `Bash`, `view` → `Read`), but `skill` has no alias and stays lowercase — hence `PreToolUse` matches `skill`, not `Skill`. `Monitor` is Claude-only and is omitted. `SessionStart` matchers are *not* filtered (a `compact` matcher fires on every session start), so `copilot.json` keeps one unmatched `SessionStart` group containing the two independent inject hooks, `session-start.mjs` and `kb-start.mjs`.

**Skill field values.** `tool_input.skill` carries the *bare* skill name under Copilot (`ralph`), not `coral:ralph`; Copilot namespaces it only when two installed plugins ship the same skill name. `isCoralSkillField()` / `isKbSkillField()` accept the bare form **only** when the host is Copilot — on Claude and Codex a bare `plan` is a user's own skill of that name, and matching it would fire Coral's hooks for a skill Coral does not own.

**Agents.** Copilot discovers a plugin's `agents/` directory even when the manifest omits the key, and exposes each as `coral:<name>` — the same identifier the skills spawn — so `agents` is declared rather than suppressed in `clients/.github/plugin/plugin.json`. Backend-only agents (`workflow-literal`, `persona-generator`) become visible as a side effect; both are harmless to spawn. **Caveat**: because Copilot fires no `SubagentStart` (see "Compact recovery and subagent inject are Claude/Codex-only" below), a `coral:*` subagent on Copilot runs **without** Coral's inject bundle, so neither `CORAL_METHODS` (`clients/hooks/coral-skill-vars.mjs`, `clients/hooks/lib/inject-render.mjs`) nor `CORAL_PROJECT` resolves inside it. Every agent that reads its methodology from `CORAL_METHODS/` — `architect`, `critic`, `debugger`, `gap-finder`, `scanner`, `resolver` — is therefore spawnable but methodology-degraded there. Declaring `agents` restores *spawn-ability*, not full parity. The `coral-cli` job path is unaffected: `src/providers/inject.ts` substitutes the same aliases for provider-run agents.

Host detection lives in `hostKind()` and keys on `COPILOT_PLUGIN_ROOT`, not `COPILOT_CLI`: Copilot exports `COPILOT_CLI` into *every* shell it spawns, so it leaks into unrelated child processes, while `COPILOT_PLUGIN_ROOT` is set only for plugin hook invocations.

### Compact recovery and subagent inject are Claude/Codex-only

`copilot.json` registers neither `PreCompact` nor the compact-recovery scripts. Copilot emits `sessionStart` only with `source` `startup`/`resume`/`new` — it never re-emits a session start after compaction — so `post-compact.mjs` could never run in the session that compacted. Registering it on the unmatched `SessionStart` group would instead have run it on *every* session start, where it consumes and **deletes** the first snapshot it finds; snapshots are keyed by project, not by session or host, so a Copilot session start would silently destroy the pending compact recovery of a concurrent Claude Code or Codex session in the same project. Until Copilot exposes a post-compaction signal, Coral does not participate in compaction there.

The subagent events are dropped for the same reason: Copilot fires `SubagentStop` (payload carries `agent_id`, `agent_type`, `last_assistant_message`) but **not** `SubagentStart`, so `subagent-start.mjs` could never inject and `subagent-track.mjs` would only ever remove a marker nothing created. Registering `SubagentStop` alone would be a no-op, so `copilot.json` drops both — matching `codex.json`. The practical consequence is that Copilot subagents do not receive Coral's inject bundle, and subagent work is not represented in the live-work registry that defers the Stop-time KB gate.

## Hook Self-Gating

All shipped hook entrypoints run `exitIfChildProcess()` first and then apply the flavor gate. `exitIfChildProcess()` suppresses Coral child-process reentry. The flavor gate compares `CORAL_FLAVOR` (unset => `prod`) with the hook bundle's own `bridge/manifest.json` flavor and exits `0` whenever the bundle should not act. This is what allows marketplace prod hooks and locally registered dev hooks to coexist without cross-firing. An unrecognized `CORAL_FLAVOR` also makes every hook inert. Centralizing its accepted-values-and-remedy diagnostic in `session-start.mjs` changes the cadence from once per hook invocation across the 14 registered entrypoints, including hooks fired by tool calls, to once per `SessionStart` event. `SessionStart` also fires on resume and compact, so the diagnostic deliberately repeats while the misconfiguration remains: every Coral hook is still disabled, and the live fault should stay visible.

The HUD auto-update hook adds one more gate: it refreshes the HUD only when `buildFlavor() === 'prod'`, so dev registrations never overwrite the prod HUD.

## Inject bundle (shared guidelines)

The `clients/inject/` directory separates behavioral guidelines, tools, and audience-scoped KB guidance:

| Fragment             | Role                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `core.md`            | Shared behavioral guidelines                                         |
| `tools.md`           | CLI, path aliases, and the live equipped-tools placeholder           |
| `kb/common.md`       | KB search and verification guidance                                  |
| `kb/orchestrator.md` | Top-level owner propagation, wiki maintenance, and source management |
| `kb/session.md`      | Session-scoped memo, promotion, update, and invalidation guidance    |

Renderers select fragments explicitly for each surface. There is no conditional-block markup inside the Markdown files. Host hooks emit the base and KB groups as separate payloads because the host applies its 8,000-byte inline-size threshold per payload. Before emission, the session and KB start hooks retain their fixed contract text and fit appended notices or project wake-up text into the bytes that remain. An oversized wake-up is cut on a UTF-8 boundary and ends with a notice naming the full project wiki path.

### Delivery paths

| Surface                                                                  | Mechanism                                                            | When                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------- |
| Host main session                                                        | `session-start.mjs` (base) + `kb-start.mjs` (KB and project wiki)    | `SessionStart`         |
| Claude Code native subagent (`Agent` tool)                               | `subagent-start.mjs` (base) + `kb-start.mjs` (KB, non-owner)         | `SubagentStart`        |
| Provider child (`coral-cli codex\|claude`, workflow atoms, discuss jobs) | `jobs/shell/launch.ts` → `applyInjectBundle` → `resolveInjectBundle` | Every job `executeJob` |

Provider children set `CORAL_CHILD=1`, so hooks self-exit and **do not** re-inject. Adapters must not re-resolve the bundle; they consume the pre-merged `request.systemPrompt` (Claude: `--append-system-prompt`; Codex: turn-text prefix — presentation order only, not a separate system channel).

### Placeholders

| Placeholder          | Meaning                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `{{CORAL_CLI}}`      | Plugin-local CLI invocation (`node "…/bridge/coral-cli.cjs"` or hook active-bridge form) |
| `{{CORAL_METHODS}}`  | Absolute `…/methods/` (trailing slash). Always filled from plugin root.                  |
| `{{CORAL_PROJECT}}`  | Project data dir (`~/.coral/projects/{slug}/…`). Left as placeholder if no project cwd.  |
| `{{CORAL_PROJECTS}}` | Same value as `{{CORAL_PROJECT}}` (legacy plural form)                                   |
| `{{PROJECT_SOURCE}}` | Project source label for the cwd                                                         |
| `{{CORAL_KB}}`       | KB root                                                                                  |
| `{{SESSION_ID}}`     | Owner session id when known                                                              |
| `{{EQUIPPED_TOOLS}}` | Live `/equip` tool list, or empty                                                        |

Path aliases in `tools.md` teach agents to open `CORAL_METHODS/HOW-*.md` and `CORAL_PROJECT/plans/…` via the resolved absolute paths rather than inventing marketplace/cache paths.

### Fragment composition

| Fragment             | SessionStart (`asOwner: true`) | SubagentStart (`asOwner: false`) | Owned provider | Anonymous provider | KB disabled |
| -------------------- | ------------------------------ | -------------------------------- | -------------- | ------------------ | ----------- |
| `core.md`            | included                       | included                         | included       | included           | included    |
| `tools.md`           | included                       | included                         | included       | included           | included    |
| `kb/common.md`       | included                       | included                         | included       | included           | omitted     |
| `kb/orchestrator.md` | included                       | omitted                          | omitted        | omitted            | omitted     |
| `kb/session.md`      | included                       | included                         | included       | omitted            | omitted     |

Orchestrator content is limited to the top-level host session. Provider children receive session guidance only when a valid `CORAL_OWNER` identifies the shared session.

### Equipped tools

The `tools.md` fragment's `{{EQUIPPED_TOOLS}}` placeholder lists agent-facing tools Coral ships `/equip` support for and that are currently installed. `clients/hooks/lib/equip-tools.mjs` holds the catalog; `resolveEquippedTools()` does a **live** filesystem probe under the engine data tree. Session-start and subagent-start both pass the live list; provider jobs pass the same list through `ProviderRuntime.equippedTools`. When the list is empty, the placeholder is stripped.

### Skill path vars

`coral-skill-vars.mjs` still injects short `CORAL_PROJECT:` / `CORAL_METHODS:` lines on skill-related `UserPromptSubmit` / `PreToolUse(Skill)` for host skill protocols. Those aliases are also present in `tools.md` for every inject surface above, so provider children and Claude-native subagents do not depend on the skill hook.

## SessionStart

`clients/hooks/session-start.mjs` renders only `core.md` and `tools.md`, adds the session header, and fits any backend-startup, migration, or project-ignore notices into the remaining payload budget. Independently, `clients/hooks/kb-start.mjs` renders the owner KB group and, when a project source is available, fits the project wiki wake-up into that payload's remaining bytes. Each script returns its payload through `hookSpecificOutput.additionalContext`, so one payload crossing the host threshold cannot discard the other.

KB wake-up reads no runtime database. `readProjectScopedWakeUp()` reads the project wiki directly from the configured Markdown KB root and fails open with `null` on missing or malformed content. An owner session without a project source still receives the fixed KB contract; only the wake-up is omitted. The separate PreCompact snapshot hook mirrors the canonical store path as `~/.coral/gen2/data/store/store.db` or `~/.coral/gen2/data-dev/store/store.db`; it validates the installed fingerprint before opening that projection read-only.

Hook SQLite access goes through the supported Node runtime's built-in `node:sqlite` module. Missing or unreadable snapshot data fails open instead of breaking hook startup.

It also:

- adds `Bash(node *coral-cli*)` permission to `settings.json` under the Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`) — the permission is user-wide, not per project
- on every valid project SessionStart, retracts Coral's exact legacy entries from the Git-root and project `.gitignore` files, independent of `CORAL_AUTO_SYMLINK`. When `.claude/coral` exists or auto-symlink is requested, Coral maintains one literal-escaped, project-relative entry for it in `.git/info/exclude`. The exclude entry starts with `/`, so it is anchored to this project directory; an unanchored pattern would match `coral` at any depth across the repository. A working-tree `.gitignore` has higher precedence than `.git/info/exclude`, so a deliberate `!coral` negation can un-ignore the symlink; the old working-tree placement could not be overridden that way.
- when `CORAL_AUTO_SYMLINK=1`, requires `.claude/` to exist as a real directory. A missing or invalid directory produces a named refusal and Coral creates no working-tree parent; create `.claude/` before the next attempt. Once preflight succeeds, Coral publishes the exclude entry, creates or repoints `.claude/coral -> ~/.coral/projects/{slug}/`, and only then retracts the legacy working-tree entries.
- runs ignore maintenance in a time-bounded child process and reports `complete`, `refused`, and `partial` results distinctly. Each refusal renders its own remedy; only retryable reasons promise another attempt at the next SessionStart, while persistent device-topology refusals require the named manual repair. A partial pass may already have changed an artifact and is not reported like a pass that never ran.
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

`wait jobs` exits `0` when every job succeeded (`completed`, or `provider_exit` whose child exited `0`), `1` for a failed, aborted, or faulted job, and with the normalized child code for `provider_exit`. Exit `75` is a nonterminal waiting outcome when the CLI prints a resume command. That command includes a cursor after the CLI has observed journal progress, but it is cursor-free if the initial `backend_recovering` or `backend_shutting_down` subscription attempts exhaust before any event is observed; follow the printed command exactly in either case. A terminal `provider_exit` whose child exited `75` also legitimately exits `75`, but prints terminal output and no resume command. A nonterminal `interrupted` line may also appear, reporting that a job's carrier was observed absent while the job is still nonterminal: the subscription stays open and the exit code stays pending, so it is informational only, never one of the exit-code outcomes above. Only the journal ends a job. It is emitted today only for durable-CLI jobs, the one carrier class whose absence local evidence can establish.

Implementation notes:

- snapshots are written under the project temp directory (`/tmp/claude-<uid>/coral/<project-slug>/hooks/active-jobs-*.json`)
- terminal recovery uses the durable artifact path under `~/.coral/exports/jobs/<jobId>/result.md` in prod or `~/.coral/exports-dev/jobs/<jobId>/result.md` in dev
- `<os-tmpdir>/coral-jobs/<jobId>/` contains live scratch artifacts such as stdout/stderr/intermediates only
- hook recovery reads CLI-visible job state and durable result artifacts, not file-backed job status records

The wait guidance matches the current CLI contract: terminal text always includes `Result path: <path>`, may include a terminal-line usage segment from job diagnostics, and `--embed` preview text is only a convenience layer. Read the printed result path for the durable artifact.

## SubagentStart

Two different “subagent” concepts must not be mixed:

| Kind                        | What it is                                                       | Inject path                                                          |
| --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Claude Code native subagent | Host `Agent` tool spawn                                          | `SubagentStart` → `subagent-start.mjs` + `kb-start.mjs`              |
| Coral provider agent        | `coral-cli codex\|claude <agent>`, workflow atom, discuss worker | **No hooks** (`CORAL_CHILD=1`); `applyInjectBundle` in the job shell |

For the first kind, `clients/hooks/subagent-start.mjs` emits the `core.md` and `tools.md` base group, while `clients/hooks/kb-start.mjs` independently emits `kb/common.md` and `kb/session.md` when KB is enabled. The KB hook omits `kb/orchestrator.md` and does not resolve a project source or read a project wake-up for subagents; its session guidance only needs the parent's session id for memo scope. `subagent-track.mjs` records live markers for Ralph / promote-gate deferral; it does not inject text.

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
