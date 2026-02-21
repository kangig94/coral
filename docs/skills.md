# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `skills/{name}/SKILL.md` — refer to those files for the full execution protocol.

| Skill | Description |
|---|---|
| `/coral:codex` | Single entry point for all Codex interactions — routes to analyst/ralph/review intent, or manages sessions directly |
| `/coral:analyze` | Deep analysis and investigation via Claude-native tools |
| `/coral:codex-analyze` | Deep analysis via Codex delegation with Claude post-processing |
| `/coral:plan` | Claude-native planning with parallel architect/critic review |
| `/coral:coplan` | Collaborative planning with Codex architect/critic reviews, then Claude cross-review |
| `/coral:ralph` | Persistent execution loop with verification (sonnet) |
| `/coral:codex-ralph` | Persistent execution via Codex with Claude-controlled verification loop |
| `/coral:init-project` | Project initialization orchestrator — generates `.claude/` structure, agents, rules, docs |
| `/coral:discuss` | Moderated multi-agent discussion via Agent Teams |
| `/coral:statusline` | Install or remove the coral HUD statusline |

## /coral:codex — Session Commands

`/coral:codex session <command>` manages named Codex sessions:

| Command | Example |
|---|---|
| `session create <name> <prompt>` | `/coral:codex session create review analyze auth.ts` |
| `session send <name> <prompt>` | `/coral:codex session send review what about JWT?` |
| `session list` | `/coral:codex session list` |
| `session fork <name>` | `/coral:codex session fork review` |

Consecutive `/coral:codex` calls without `session` automatically continue the previous session. Say "new" to start fresh.
