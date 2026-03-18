# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `skills/{name}/SKILL.md` - refer to those files for the full execution protocol.

## Methods

Cross-cutting methodology files live in `methods/`. Agents and skills reference them via the `CORAL_METHODS` path alias. See [docs/methodology.md](./methodology.md) for the full connection architecture.

| Method | Consumers | Purpose |
|--------|-----------|---------|
| `HOW-REVIEW.md` | architect, critic | Adversarial review with counterexample checklist + reasoning failure taxonomy |
| `HOW-SYNTHESIZE.md` | resolver, plan | Multi-reviewer feedback synthesis (Adopt/Adapt/Defer/Diverge) |
| `HOW-RESOLVE.md` | resolver | Constraint Collision resolution via TRIZ inventive principles |
| `HOW-COMPLETE.md` | plan | Review loop exit evaluation (frame stability, counterexample coverage) |
| `HOW-FALSIFY.md` | debugger, scanner | Competing hypothesis elimination via Vitanda (pure destruction) |
| `HOW-CONFIDENCE.md` | debugger | GRADE-based evidence confidence grading (4 tiers, 2-phase algorithm) |
| `HOW-PROVENANCE.md` | architect, critic, debugger, scanner, gap-finder | Evidence source chain (claim → source → identifier → verification) |
| `HOW-ELICIT.md` | gap-finder, preplan | Multi-lens gap detection (HAZOP deviation + Pre-mortem + ABP assumptions) |

| Skill | Description |
|---|---|
| `/coral:codex` | Single entry point for all Codex interactions - routes to scanner/gap-finder/ralph/review intent, or manages sessions directly |
| `/coral:analyze` | Deep analysis and investigation with HOW methods always applied. Pass `--codex` to delegate to Codex CLI |
| `/coral:preplan` | Structured problem-definition conversation before planning. Aligns understanding with the user before triggering coral:plan |
| `/coral:plan` | Planning with parallel architect/critic review. Pass `--deep` for methodology-driven synthesis, `--codex` for cross-model Codex reviews |
| `/coral:ralph` | Persistent execution loop with verification (sonnet). Flags: `--codex` (Codex delegation), `--team` (parallel AC execution via Agent Teams), `--red` (adversarial tests). All flags are combinable. |
| `/coral:code-simplify` | Simplify and refine code for clarity, consistency, and maintainability |
| `/coral:bugfix` | Systematic bug diagnosis, planning, and fix execution |
| `/coral:init-project` | Project initialization orchestrator - generates `.claude/` structure, agents, rules, docs |
| `/coral:discuss` | Moderated multi-agent discussion via Agent Teams |
| `/coral:bid` | Submit a bid or speech in an active `--user` discuss session |
| `/coral:statusline` | Install or remove the coral HUD statusline |

## --red Flag (Adversarial Testing)

`/coral:ralph --red <task>` spawns a red-attacker **before implementation begins**, running adversarial test generation in parallel with the main work:

1. Red-attacker spawns at step 2 (plan mode) or step 3 start (prompt mode) with plan file + AC as input
2. Implementation proceeds in parallel — red-attacker works independently in `$TMPDIR/coral/<project-slug>/red/`
3. Post-implementation: wait for red-attacker, move staged tests into test directory, run full suite
4. Fix loop: fix failures → re-run (max 3 iterations), then escalate

**Spawn method** (opposite model from main execution):
- `--red` (Claude implements) → `codex({ op: "coral:red-attacker" })` (Codex tests)
- `--red --codex` (Codex implements) → `Agent("coral:red-attacker")` (Claude tests)
- `--red --team` → red-attacker joins as teammate in the worker team (Codex via `<Codex_Mode>`)
- `--red --team --codex` → red-attacker joins as teammate (Claude, since workers use Codex)

**Test file lifecycle**: red-attacker writes as `red-<target>.<ext>` (e.g., `red-auth.test.ts`). After tests pass, ralph triages — valid tests are merged into main test files and `red-` files are deleted; failing triage tests are discarded.

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
2. **Plan**: Write plan following embedded protocol in `skills/plan/SKILL.md`, verify with reviewers
3. **Execute**: Spawn ralph to generate all files per the plan
4. **Report**: Summary of generated artifacts

The init-project skill reads `agents/init-project.md` for its full execution protocol.
