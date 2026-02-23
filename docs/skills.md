# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `skills/{name}/SKILL.md` - refer to those files for the full execution protocol.

| Skill | Description |
|---|---|
| `/coral:codex` | Single entry point for all Codex interactions - routes to scanner/gap-finder/ralph/review intent, or manages sessions directly |
| `/coral:analyze` | Deep analysis and investigation. Pass `--codex` to delegate to Codex CLI |
| `/coral:plan` | Claude-native planning with parallel architect/critic review |
| `/coral:coplan` | Collaborative planning with Codex architect/critic reviews, then Claude cross-review |
| `/coral:ralph` | Persistent execution loop with verification (sonnet). Use `--red` to add adversarial tests after implementation. |
| `/coral:codex-ralph` | Persistent execution via Codex with Claude-controlled verification loop. Use `--red` to add adversarial tests after implementation. |
| `/coral:code-simplify` | Simplify and refine code for clarity, consistency, and maintainability |
| `/coral:debug` | Systematic bug diagnosis, planning, and fix execution |
| `/coral:init-project` | Project initialization orchestrator - generates `.claude/` structure, agents, rules, docs |
| `/coral:discuss` | Moderated multi-agent discussion via Agent Teams |
| `/coral:statusline` | Install or remove the coral HUD statusline |

## --red Flag (Adversarial Testing)

`/coral:ralph --red <task>` and `/coral:codex-ralph --red <task>` add a red-team test generation phase after implementation:

1. `coral:red-attacker` spawns in the **background** immediately before lint
2. Foreground continues: lint → parallel validation → build
3. After build: wait for red-attacker to finish, then run the full test suite (including adversarial tests)
4. If adversarial tests fail: fix loop runs (max 3 iterations), then escalates

**Ensemble diversity**: ralph uses Claude as implementer → red-attacker delegates to Codex. codex-ralph uses Codex as implementer → red-attacker uses Claude directly. Different models have different blind spots — the adversarial tests target what the implementer missed.

**Test file naming**: red-attacker writes to the project's test directory as `red-<target>.<ext>` (e.g., `red-auth.test.ts`, `test_red_session.py`). Tests persist after the run — the user can review and keep them as regression tests.

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

## /coral:init-project - Project Initialization

Scans the current project and generates the complete `.claude/` structure:

```bash
/coral:init-project
```

Phases:
1. **Scan**: Detect stack (languages, frameworks, test runner, build tool), identify domains
2. **Plan**: Spawn planner to generate a verified artifact plan
3. **Execute**: Spawn ralph to generate all files per the plan
4. **Report**: Summary of generated artifacts

The init-project skill reads `agents/init-project.md` for its full execution protocol.
