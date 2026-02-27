# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `skills/{name}/SKILL.md` - refer to those files for the full execution protocol.

| Skill | Description |
|---|---|
| `/coral:codex` | Single entry point for all Codex interactions - routes to scanner/gap-finder/ralph/review intent, or manages sessions directly |
| `/coral:analyze` | Deep analysis and investigation. Pass `--codex` to delegate to Codex CLI |
| `/coral:plan` | Planning with parallel architect/critic review. Pass `--codex` for cross-model Codex reviews |
| `/coral:ralph` | Persistent execution loop with verification (sonnet). Pass `--codex` to delegate to Codex CLI. Use `--red` to add adversarial tests after implementation. |
| `/coral:code-simplify` | Simplify and refine code for clarity, consistency, and maintainability |
| `/coral:bugfix` | Systematic bug diagnosis, planning, and fix execution |
| `/coral:init-project` | Project initialization orchestrator - generates `.claude/` structure, agents, rules, docs |
| `/coral:discuss` | Moderated multi-agent discussion via Agent Teams |
| `/coral:bid` | Submit a bid or speech in an active `--user` discuss session |
| `/coral:statusline` | Install or remove the coral HUD statusline |

## --red Flag (Adversarial Testing)

`/coral:ralph --red <task>` adds a red-team test generation phase after implementation:

1. `coral:red-attacker` spawns in the **background** immediately before lint
2. Foreground continues: lint → parallel validation → build
3. After build: wait for red-attacker to finish, then run the full test suite (including adversarial tests)
4. If adversarial tests fail: fix loop runs (max 3 iterations), then escalates

**Ensemble diversity**: ralph automatically passes the opposite `--codex` flag to red-attacker. `/coral:ralph --red` (Claude implements) → red-attacker gets `--codex` (Codex tests). `/coral:ralph --red --codex` (Codex implements) → red-attacker runs without `--codex` (Claude tests). Different models have different blind spots.

**Test file lifecycle**: red-attacker writes to the project's test directory as `red-<target>.<ext>` (e.g., `red-auth.test.ts`, `test_red_session.py`). After tests pass, ralph triages each red test — passing tests are merged into the main test file and the `red-` file is deleted; failing triage tests are discarded. Adversarial test provenance is recorded in the commit message, not in file naming.

## /coral:codex - Session Commands

`/coral:codex session <command>` manages named Codex sessions:

| Command | Example |
|---|---|
| `session create <name> <prompt>` | `/coral:codex session create review analyze auth.ts` |
| `session send <name> <prompt>` | `/coral:codex session send review what about JWT?` |
| `session list` | `/coral:codex session list` |
| `session fork <name>` | `/coral:codex session fork review` |

Consecutive `/coral:codex` calls without `session` automatically continue the previous session. Say "new" to start fresh.

## /coral:discuss - Moderated Discussion

Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable.

```bash
/coral:discuss "Should we adopt microservices?"
/coral:discuss "AI ethics in healthcare" --hints stance:pro,con priority:safety,innovation
```

The `--hints` flag provides controversy axis hints to the moderator. The moderator still performs its own topic analysis — hints are suggestions, not mandates.

See [docs/discuss.md](./discuss.md) for the full discussion system design.

## /coral:bid - Bid or Speak in Discussion

Requires an active `--user` discuss session (started via `/coral:discuss --user <topic>`).

```bash
/coral:bid 50, I want to address the scalability concern   # bid with score + thought
/coral:bid I think we should use a microservices approach   # deliver a speech
```

The first comma separates score from thought. If the left side is an integer 0-100, it's a bid; otherwise the entire string is treated as speech content.

## /coral:init-project - Project Initialization

Scans the current project and generates the complete `.claude/` structure:

```bash
/coral:init-project
```

Phases:
1. **Scan**: Detect stack (languages, frameworks, test runner, build tool), identify domains
2. **Plan**: Write plan following `skills/plan/PROTOCOL.md`, verify with reviewers
3. **Execute**: Spawn ralph to generate all files per the plan
4. **Report**: Summary of generated artifacts

The init-project skill reads `agents/init-project.md` for its full execution protocol.
