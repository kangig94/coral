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

## `/coral:equip`

`/coral:equip codebase-memory` uses an existing executable found on an eligible local PATH entry or in the standard installation directory. It runs the official installer for installation or when it can migrate a legacy copy. The installer puts `codebase-memory-mcp` in `~/.local/bin` and configures supported agents. The installer may create or overwrite the updater at `~/.local/bin/install.sh`. `/coral:equip --list` and `/coral:equip info codebase-memory` show the resolved copy and flag a legacy Coral copy.

Use `/coral:equip --update codebase-memory` to refresh the standard copy through the official installer. Use the original install source to update other PATH copies or uninstall Codebase Memory. See [agent tool locations](./configuration.md#agent-tool-locations).

## Common CLI Launch Pattern

Many skills launch a job and wait for it in a separate command.

```bash
coral-cli codex --work-dir "<path>" -i - <<'CORAL_INPUT'
<prompt>
CORAL_INPUT
cd "<path>" && coral-cli jobs wait <jobId> --embed
```

Rules:

1. Launch a provider job when a skill needs a durable provider conversation. The launch returns after the decision.
2. Capture `jobId` from the line `Provider job <jobId> execution #<n> <launchState>`. An accepted launch also prints `command=coral-cli jobs wait <jobId>`. That id names the provider conversation; later turns use execution ordinals on the same job.
3. Monitor with `coral-cli jobs wait`. Unbound operators can monitor from any working directory. Bound sessions use a directory that contains the job’s work directory within their project binding. Use `--all` for a batch and the harness background execution for long waits. Admission pins the execution being collected, and terminal lines include usage diagnostics when available. Use the exact printed continuation, preserving every argument, when collection is interrupted.
4. With `--embed`, the inline text is a preview. Read the full artifact at the printed `Result path: <path>` when available. Otherwise use `coral-cli jobs detail <id> --full` for retained results across executions.
5. Interpret `jobs wait` exit codes together with its rendered output: the first failed outcome in request order determines the exit among printed results (all collected results with `--all`) (`1` for a failed, aborted, or faulted job; the normalized child code for `provider_exit`). A zero mapped code returns `0` when no requested siblings remain and `75` when they do. Exit `75` alone does not classify the outcome. Branch on the rendered output: the terminal header marks a terminal result, a terminal continuation names outstanding sibling IDs, `Still waiting` carries a cursor, and `remediation:` supplies recovery instructions. Follow a remediation only if it contains a `coral-cli jobs wait` command; otherwise stop and surface the rendered error. `wait_build_mismatch` requires restarting the session. A terminal block with remaining siblings prints the command for waiting on them. A nonterminal `interrupted` line may also appear mid-stream, reporting a job's carrier observed absent while the job is still nonterminal; it leaves the subscription open and the exit code pending, so it is informational only and not one of the outcomes above. Only durable-CLI jobs produce it today — the one carrier class whose absence local evidence can establish.

See [`jobs send` outcomes](./cli-errors.md#jobs-send-outcomes) for the command contract and refusal remedies.

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

## `tier-review`

Coral's repository and projects scaffolded by `init-project` use `tier-review` to consolidate reviewer reports into **In scope**, **Out of scope**, and **Improbable**. When multiple reviewers report the same defect, the skill keeps the stricter finding tier (In scope > Out of scope > Improbable) before resolving severity disagreements. The verdict uses only In scope findings. An agent verdict can floor an unlabeled In scope finding and the reported severity takes precedence when a label is present.

Every reviewer and the consolidator use the caller-supplied scope. If the caller supplies none, they use the staged and unstaged diff.

With `--gated`, a BLOCKING In scope finding from the first wave stops the review. Otherwise, the code review waves finish and In scope code findings are addressed before documentation review begins. See the [review finding format](./agents.md#review-findings).
