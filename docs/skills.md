# Skills (Slash Commands)

Slash commands provided by the Coral plugin. Each skill is defined in `clients/skills/{name}/SKILL.md`.

## Methods

Cross-cutting methodology files live in `clients/methods/`. Agents and skills reference them through the `CORAL_METHODS` path alias.

Resolved absolute paths are injected through `inject/tools.md` (`{{CORAL_METHODS}}` / `{{CORAL_PROJECT}}`) for host sessions, Claude-native subagents, and provider children. Host skill flows also get short alias lines from `coral-skill-vars.mjs`. See [Hooks — Inject bundle](./hooks.md#inject-bundle-shared-guidelines).

| Method              | Consumers                                        | Purpose                                          |
| ------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `HOW-REVIEW.md`     | architect, critic                                | Adversarial review with counterexample checklist |
| `HOW-SYNTHESIZE.md` | resolver, plan                                   | Multi-reviewer synthesis                         |
| `HOW-RESOLVE.md`    | resolver                                         | Constraint-collision resolution                  |
| `HOW-FALSIFY.md`    | debugger, scanner                                | Hypothesis elimination                           |
| `HOW-CONFIDENCE.md` | debugger                                         | Evidence confidence grading                      |
| `HOW-PROVENANCE.md` | architect, critic, debugger, scanner, gap-finder | Evidence chain tracking                          |
| `HOW-ELICIT.md`     | gap-finder, preplan                              | Multi-lens gap detection                         |

## Skill Catalog

| Skill                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/coral:analyze`       | Deep analysis and investigation; `--delegate` runs on the other host                                                                                                                                                                                                                                                                                                                                                              |
| `/coral:preplan`       | Structured problem-definition conversation before planning                                                                                                                                                                                                                                                                                                                                                                        |
| `/coral:plan`          | Planning with architect/critic review; `round=N` sets the review-round budget for every applicable phase (default 1); `round=N,M,…` gives phase i the i-th value and turns `--delegate` on, where `0` skips a phase and a third or later value adds one — odd phases review on the other host, even phases on the current one; `--delegate` adds a review phase on the other host, and Phase 2 is skipped when it would repeat it |
| `/coral:ralph`         | Persistent execution loop with verification; supports `--delegate` and `--red`                                                                                                                                                                                                                                                                                                                                                    |
| `/coral:code-simplify` | Code simplification and cleanup                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/coral:bugfix`        | Diagnosis, planning, and fix execution                                                                                                                                                                                                                                                                                                                                                                                            |
| `/coral:equip`         | Install Coral companion tooling and KB runtime helpers                                                                                                                                                                                                                                                                                                                                                                            |
| `/coral:init-project`  | Generate project-specific Coral structure and docs                                                                                                                                                                                                                                                                                                                                                                                |
| `/coral:discuss`       | Moderated multi-agent discussion                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/coral:bid`           | Submit a bid or speech into an active discuss session                                                                                                                                                                                                                                                                                                                                                                             |
| `/coral:statusline`    | Install or remove the Coral HUD statusline                                                                                                                                                                                                                                                                                                                                                                                        |

## Common CLI Launch Pattern

Many skills follow the same detached-launch pattern:

```bash
coral-cli codex --work-dir "<path>" -d -i - <<'CORAL_INPUT'
<prompt>
CORAL_INPUT
cd "<path>" && coral-cli wait jobs <jobId> --embed
```

Rules:

1. Use detached launches when a skill needs a durable provider job and provider conversation.
2. Capture `jobId` and `sessionId` from the launch line: `Provider job <jobId> <launchState> (provider session <sessionId>)`.
3. Monitor with `coral-cli wait`; terminal lines include usage diagnostics when provider data is available.
4. `Result path: <path>` identifies an available artifact. Read an `Unverified result path:` only if the file exists. A final outcome without a path remains collected; use `coral-cli jobs detail <jobId> --full` for full retained content. `the outcome above is final; Coral is writing the result file` keeps an artifact follow-up pending; `result file now available` supplies the path without replaying the outcome. Retained-away and failed artifacts report their retention/cause and retry guidance.
5. The first failed terminal in request order keeps its mapped exit code even with siblings or after acknowledgement. Otherwise permanent refusals exit 1, remaining collection work exits 75, and exhausted successful sets exit 0. Siblings are results still to collect; unread progress, discovery, artifact settlement and unknown carriers can also require continuation. Follow the single exact printed command and cursor. `Carrier unconfirmed for: <ids>` preserves uncertainty and never authorizes finalization. An `interrupted` carrier-absence line leaves the stream open and requires no action.
6. `--now` reads an immediate snapshot with bounded UTF-8-safe labeled previews. Truncated previews report omitted content through `contentOmitted` and `diagnosticOmitted` booleans, without exact omitted byte counts. Its continuation retains `--now`; dropping it opens a blocking wait. The saved-cursor replay notice permits repeated outcomes; a membership-change notice permits progress replay while preserving collected outcomes. Ctrl+C ends monitoring without aborting jobs; launch-and-follow keeps its double-Ctrl+C abort.
7. For scope mismatch, change cwd to the job work directory or a containing directory and rerun. `coral-cli jobs --all` includes terminal jobs and shows work directories.

## `--red` Flag

`/coral:ralph --red <task>` runs adversarial testing in parallel with implementation.

- `--red` spawns the red-attacker as a background agent on the current host, with or without `--delegate`; only the implementation moves to the other host under `--delegate`
- The red-attacker writes its tests to a temporary directory; after the build and the normal test suite pass, ralph adapts them to the real API, runs and triages them, and merges the kept tests into the existing test files — no separate `red-*` test files remain

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
