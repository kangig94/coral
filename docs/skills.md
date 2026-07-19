# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `clients/skills/{name}/SKILL.md`.

## Methods

Cross-cutting methodology files live in `clients/methods/`. Agents and skills reference them through the `CORAL_METHODS` path alias.

Resolved absolute paths are injected through `inject/tools.md` (`{{CORAL_METHODS}}` / `{{CORAL_PROJECT}}`) for host sessions, Claude-native subagents, and provider children. Host skill flows also get short alias lines from `coral-skill-vars.mjs`. See [Hooks — Inject bundle](./hooks.md#inject-bundle-shared-guidelines).

| Method | Consumers | Purpose |
| --- | --- | --- |
| `HOW-REVIEW.md` | architect, critic | Adversarial review with counterexample checklist |
| `HOW-SYNTHESIZE.md` | resolver, plan | Multi-reviewer synthesis |
| `HOW-RESOLVE.md` | resolver | Constraint-collision resolution |
| `HOW-FALSIFY.md` | debugger, scanner | Hypothesis elimination |
| `HOW-CONFIDENCE.md` | debugger | Evidence confidence grading |
| `HOW-PROVENANCE.md` | architect, critic, debugger, scanner, gap-finder | Evidence chain tracking |
| `HOW-ELICIT.md` | gap-finder, preplan | Multi-lens gap detection |

## Skill Catalog

| Skill | Description |
| --- | --- |
| `/coral:analyze` | Deep analysis and investigation; `--delegate` runs on the other host |
| `/coral:preplan` | Structured problem-definition conversation before planning |
| `/coral:plan` | Planning with architect/critic review; `round=N` sets the review-round budget per phase (default 1); `--delegate` adds a review round on the other host |
| `/coral:ralph` | Persistent execution loop with verification; supports `--delegate`, `--team`, and `--red` |
| `/coral:code-simplify` | Code simplification and cleanup |
| `/coral:bugfix` | Diagnosis, planning, and fix execution |
| `/coral:equip` | Install Coral companion tooling and KB runtime helpers |
| `/coral:init-project` | Generate project-specific Coral structure and docs |
| `/coral:discuss` | Moderated multi-agent discussion |
| `/coral:bid` | Submit a bid or speech into an active discuss session |
| `/coral:statusline` | Install or remove the Coral HUD statusline |

## Common CLI Launch Pattern

Many skills follow the same detached-launch pattern:

```bash
coral-cli codex -i "<prompt>" --work-dir "<path>" -d
coral-cli wait jobs <job> --embed
```

Rules:

1. Use detached launches when a skill needs a durable `job` or `session`.
2. Capture `job` and `session` from the launch line: `Job <job> <launchState> (session <session>)`.
3. Monitor with `coral-cli wait`; terminal lines include usage diagnostics when provider data is available.
4. For `--embed`, use inline preview text when it helps, but read the printed `Result path: <path>` for the full artifact.

## `--red` Flag

`/coral:ralph --red <task>` runs adversarial testing in parallel with implementation.

- `--red` runs the red-attacker on the opposite host from the implementation for diversity (e.g., when implementation runs on Claude, red-attacker launches through `coral-cli codex red-attacker -i ...`)
- `--red --delegate` flips the implementation host; the red-attacker still uses the opposite host
- `--red --team` integrates the attacker into teammate orchestration

Generated tests use `red-<target>.<ext>` staging names and are triaged before being merged into the main suite.

## `/coral:discuss`

Example usage:

```bash
/coral:discuss "Should we adopt microservices?"
/coral:discuss "AI ethics in healthcare" --hints stance:pro,con priority:safety,innovation
```

The underlying runtime uses:

- `coral-cli discuss seed`
- `coral-cli discuss start`
- `coral-cli discuss watch`
- `coral-cli discuss participate`
- `coral-cli discuss abort`

See [Discuss](./discuss.md) for the event model and persistence rules.

## `/coral:bid`

Requires an active `--user` discuss session:

```bash
/coral:bid 50, I want to address the scalability concern
/coral:bid I think we should use a microservices approach
```

The first comma determines whether the input is parsed as a bid (`score, thought`) or as speech content.

## `/coral:init-project`

`/coral:init-project` scans the current project and generates the Coral scaffolding:

1. Scan the stack and project structure.
2. Write and review a plan.
3. Execute the plan through Coral protocols.
4. Report the generated artifacts.

The full protocol lives in `clients/skills/init-project/SKILL.md`.
