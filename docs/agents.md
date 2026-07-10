# Agents

Coral has three agent surfaces:

- Claude-native agents that run directly in Claude Code.
- Codex-delegated agents launched through `coral-cli codex <agent> -i ...`.
- Skill-owned protocols such as `ralph`, `plan`, and `init-project`.

Codex delegation is a normal CLI-to-backend provider launch.

## Routing Rules

| User request | Routing | Reason |
| --- | --- | --- |
| "review with architect" | Self-execute `architect` on current host | Default read-only reviewer |
| "review with the other host's architect" | `coral-cli <other-host> architect -i ...` | Explicit cross-host delegation |
| "review with critic" | Self-execute `critic` on current host | Default critical reviewer |
| "run ralph on this task" | `/coral:ralph` | Skill-owned execution protocol |
| "delegate ralph this task" | `/coral:ralph --delegate` | Cross-host execution through CLI launch + wait |

## Claude-native Agents

| Agent | File | Role |
| --- | --- | --- |
| `architect` | `agents/architect.md` | Architecture analysis and plan review |
| `critic` | `agents/critic.md` | Code and plan review |
| `debugger` | `agents/debugger.md` | Root-cause diagnosis |
| `scanner` | `agents/scanner.md` | Project scanning and process investigation |
| `gap-finder` | `agents/gap-finder.md` | Requirement and scope gap analysis |
| `resolver` | `agents/resolver.md` | Review synthesis and contradiction resolution |
| `red-attacker` | `agents/red-attacker.md` | Adversarial test generation |
| `pioneer` | `agents/pioneer.md` | Most-elegant-design exploration, cost-blind |
| `persona-generator` | `agents/persona-generator.md` | Discuss persona generation |
| `workflow-literal` | `agents/workflow-literal.md` | Pipeline step processor for workflow DSL inline prompts |

These agents use Claude Code's native tools. Read-only agents declare `disallowedTools`; execution-oriented agents do not.

When spawned via Claude's `Agent` tool inside a host session, they receive `INJECT.md` through the `SubagentStart` hook (`asOwner: false` — owner-only blocks stripped). When launched as provider jobs (`coral-cli … <agent>` or workflow), they receive the same file via `applyInjectMd` (no hooks). See [Hooks — INJECT.md](./hooks.md#injectmd-shared-guidelines).

Agent bodies may say `read CORAL_METHODS/HOW-….md`. That alias resolves from inject path aliases (`{{CORAL_METHODS}}`); agents do not hardcode marketplace install paths.

## Skill-owned Protocols

| Skill | Surface | Role |
| --- | --- | --- |
| `ralph` | `skills/ralph/SKILL.md` | Persistent task execution with verification |
| `plan` | `skills/plan/SKILL.md` | Multi-round planning and review orchestration |
| `init-project` | `skills/init-project/SKILL.md` | Project initialization orchestration |

These are protocols, not standalone agent files.

## Codex Delegation

Codex-backed agent launches use the provider route, not a protocol-specific transport:

```bash
coral-cli codex architect -i "<prompt>" --work-dir "<path>" -d
coral-cli codex critic -i "<prompt>" --work-dir "<path>" -d
coral-cli wait jobs <job-id...> --embed
```

Behavior:

1. `ExecutionService.coralDispatch()` / `JobLaunchService` resolves `agents/<name>.md` into a system-channel `instruction` (frontmatter stripped; `model:` may set default model).
2. `jobs/shell/launch.ts` `executeJob` applies provider-agnostic `INJECT.md` via `applyInjectMd` (pre-merged into `systemPrompt`; never overwrites an existing caller systemPrompt — prepend/merge). Hooks do not run (`CORAL_CHILD=1`).
3. The provider adapter consumes `instruction` + `systemPrompt` + `prompt`:
   - Claude: system append channel + user prompt
   - Codex: single turn text ordered `systemPrompt` → `instruction` → `prompt` (order is presentation only)
4. Detached launches print `Job <job> <launchState> (session <session>)`, and `wait --embed` prints the terminal line, any available usage diagnostics, and `Result path: <path>` for durable artifact recovery.
5. The job is persisted like any other provider execution. Workflow atoms and discuss workers use the same job shell path.

Unknown agent names fail through the normal provider/domain error path.

## Discuss Agents

Discuss participants are coordinator-managed provider sessions, not Agent Teams and not protocol clients. The normal entrypoints are:

- `coral-cli discuss seed`
- `coral-cli discuss start`
- `coral-cli discuss watch`
- `coral-cli discuss participate`
- `coral-cli discuss abort`

See [Discuss](./discuss.md) for the runtime model.

## Internal Review Agents

Coral's internal governance agents live under `.claude/agents/`. The contract-focused reviewer is `integration-guardian`, which validates CLI/backend contracts, schema changes, and structured output behavior.

## Adding New Agents

### Claude-native agent

Create `agents/<name>.md` and route to it through Claude Code's normal agent selection rules.

### Codex-delegated agent

Create `agents/<name>.md` and invoke it through the Codex provider surface:

```bash
coral-cli codex <name> -i "<prompt>" --work-dir "<path>" -d
coral-cli wait jobs <job> --embed
```

### Prompt design guidance

- Keep one primary responsibility per agent.
- Reference methodology files from `methods/` instead of copying them inline.
- Use read-only tool restrictions when the agent should never mutate files.
- Keep output formats explicit so downstream skills can synthesize or verify the result.
