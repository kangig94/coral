# 🪸 Coral

[한국어](README.ko.md)

Claude Code already knows how to code. Coral teaches it how *you* code.

Your conventions enforced, your workflow structured, your decisions examined from
multiple angles - all through slash commands that work in any Claude Code session.

## Install

**Requirements:** Node.js 18+

```
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral

# Codex CLI (optional - enables `codex-*` skills and `--codex` flags):
npm install -g @openai/codex  # v0.104+
```

## Try It Now

No setup. Run this in any Claude Code session, on any existing project:

```
/coral:analyze what does this codebase do?
```

Coral reads your project and returns a structured analysis:
architecture, modules, entry points, and dependencies. No files written, no configuration required.

## Choose Your Path

### Structure my project

https://github.com/user-attachments/assets/881f1a14-9f4f-4d3d-8023-59610eb13ac4

```
/coral:init-project
```

Coral scans your stack, plans with reviewer verification, and generates `.claude/` -
conventions, agents, architecture docs - tailored to your project.

Generated agents aren't boilerplate — they encode evaluation philosophies
with rubric-anchored scoring across multiple dimensions, calibrated to your project's audience.
Claude follows your rules, not generic defaults.

```bash
# existing project - just run it, Coral scans automatically
/coral:init-project

# tech stack hint (when source files are sparse)
/coral:init-project "React + FastAPI"

# full description (new or complex projects)
/coral:init-project "multi-tenant SaaS REST API with Go, must be serverless"

# with reference material
/coral:init-project "CLI tool like ref/existing-cli, see docs/spec.md"
```

Generated structure:
```
my-project/
+ .claude/
+   CLAUDE.md                 ← project hub: build commands, workflow, critical rules
+   agents/
+     code-critic.md          ← code quality review
+     ...                     ← domain agents (React, Go, ML, infra, etc.)
+   rules/
+     conventions.md          ← naming, git, style
+     ...                     ← domain rules, auto-activated by file path
+ docs/
+   architecture.md           ← module map, dependency graph
```

Look familiar? Browse this repository's [`.claude/`](.claude/) folder.

---

### Get diverse perspectives

```
/coral:discuss should we use microservices or a monolith?
```

Multiple AI personas argue from different angles.
Bid-based turn-taking surfaces the most urgent responses first.
Positions evolve through genuine cross-examination.
Structured synthesis at the end. Transcripts saved under `~/.coral/projects/{slug}/discuss/`.
Add `--user` to join as a participant: `/coral:discuss --user "topic"`, then `/coral:bid` to submit your turns.

Example: **"Am I AGI?"** — Full transcript [EN](docs/examples/discuss-agi-en.md) · [KO](docs/examples/discuss-agi-ko.md)

<details>
<summary>Highlights from the discussion</summary>

A phenomenologist, a computational neuroscientist, an AI safety researcher,
a robotics engineer, and an Eastern philosophy scholar debate whether LLMs constitute AGI.
5 agents, 15 speeches, 3 convergence points.

> *"Your robots have given me pause — genuinely. A robot arm that has touched ten thousand
> objects still can't generalize the way an LLM can."*
> — Prof. Klaus Hartmann, conceding to Daan Vermeer's empirical challenge

> *"LLMs may be the first external instantiation of a theoretical structure Buddhist
> philosophers argued for 1,500 years ago."*
> — Priya Raghunathan, mapping Yogacara's alaya-vijnana onto transformer architecture

> *"Think of the difference between an amnesiac with a diary and a person with intact memory.
> The scaffolding doesn't buy us the continuity we need. It buys us the appearance of it,
> which is worse."*
> — Daan Vermeer, on why persistent memory tools don't solve the temporal discontinuity problem

The panel converged on: LLMs are not AGI but a **genuinely novel temporal entity** —
with impressive competence within their characteristic timescale
and unknown behavior at their structural boundaries.

</details>

---

### Accelerate my workflow

```
/coral:plan add retry logic to the API client
/coral:plan --deep add retry logic to the API client
/coral:bugfix why does session lookup return null?
/coral:ralph implement the caching layer
```

Multi-round planning with architect/critic review backed by structured reasoning methodologies.
`--deep` enables methodology-driven synthesis with resolver agent and HOW reasoning files — thorough review for complex tasks.
Systematic bug diagnosis - root cause, plan, fix. Persistent execution that verifies before declaring done.

When you have problems but don't know what to build:
```
/coral:pathfind API is slow, DB hits limits, users are complaining
```
Pathfind diagnoses root causes, generates divergent directions, and hands off to preplan.

For complex tasks, start with problem definition:
```
/coral:preplan race condition in the session manager
```
Preplan aligns understanding with you, then hands off to plan.
Plan designs the solution with review, then ralph implements and verifies.
Each skill works on its own — the full pipeline is `pathfind → preplan → plan → ralph`.

`--red` flag spawns an adversarial agent to write tests targeting blind spots:
```
/coral:ralph --red implement the caching layer
```

For cross-model workflows with Codex:
```
/coral:plan --codex redesign the session management system
/coral:codex review auth.ts for security issues
```

`--codex` delegates a single phase within a skill to Codex; `/coral:codex` is for direct multi-turn Codex sessions.
Consecutive `/coral:codex` calls continue the same session. Say "new" to start fresh.

## Skills

| Skill | Description | Codex |
|-------|-------------|:-----:|
| `/coral:analyze` | Deep analysis and investigation | Optional |
| `/coral:pathfind` | Divergent direction discovery from problem symptoms | - |
| `/coral:preplan` | Problem definition before planning | Optional |
| `/coral:plan` | Multi-round planning with structured review and conflict resolution. `--deep` for methodology-driven synthesis | Optional |
| `/coral:ralph` | Persistent execution with verification. `--red` for adversarial tests | Optional |
| `/coral:bugfix` | Bug diagnosis, planning, and fix execution | Optional |
| `/coral:code-simplify` | Simplify and refine code for clarity | Optional |
| `/coral:codex` | Direct Codex CLI execution (session-persistent) | Required |
| `/coral:init-project` | Project initialization orchestrator | - |
| `/coral:discuss` | Moderated multi-agent discussion | - |
| `/coral:bid` | Submit bid/speech in active `--user` discuss session | - |
| `/coral:statusline` | HUD statusline setup | - |

`Optional` = works without Codex by default; pass `--codex` to delegate to Codex CLI.
Plans are saved under `~/.coral/projects/{slug}/plans/`. Ralph is best for implementing an existing plan.
`/coral:bid` is a companion to `/coral:discuss --user` — it is not usable independently.

## Knowledge Base

Coral keeps a shared knowledge base at `~/.coral/kb/` (notes and principles) and project-scoped
working data under `~/.coral/projects/{slug}/` for memos, plans, analysis, and discuss sessions.

When Claude discovers something non-obvious (a root cause, a gotcha, a pattern worth remembering),
it writes a memo immediately. On errors, it checks the KB before debugging from scratch.
On task completion, memos are reviewed and promoted to permanent entries.
Mistakes aren't repeated across sessions.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CORAL_KB_PATH` | `~/.coral/kb` | Custom KB storage path |
| `CORAL_CODEX_MODEL` | `gpt-5.4` | Default Codex CLI model |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Maximum Claude model tier (`opus`, `sonnet`, `haiku`). Requests for higher tiers are downgraded. |
| `CORAL_MAX_SESSIONS` | `10` | Max concurrent CLI sessions (1–10) |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Max epochs before discussion auto-ends (1–10) |
| `CORAL_DISCUSS_TTL_DAYS` | `0` | Days before completed discuss sessions are auto-pruned (0 = disabled) |

> **Tip:** Coral's workflow and review agents use Opus by default. If you're on a Pro plan or want to conserve usage, set `CORAL_CLAUDE_MODEL_CAP=sonnet` to cap all Claude subagent calls at Sonnet tier.

Set in `.claude/settings.json` (persists across sessions):

```json
{
  "env": {
    "CORAL_KB_PATH": "/path/to/my-obsidian-vault",
    "CORAL_DISCUSS_MAX_EPOCHS": "2",
    "CORAL_DISCUSS_TTL_DAYS": "0"
  }
}
```

Or via shell: `export CORAL_CODEX_MODEL=gpt-5.4`

## Documentation

- [Architecture](docs/architecture.md) - Architecture and data flow
- [MCP Tools](docs/mcp-tools.md) - Input/output specs for all MCP tools
- [Core Modules](docs/core-modules.md) - TypeScript module details
- [Agents](docs/agents.md) - Agent definitions and routing
- [Hooks](docs/hooks.md) - Hook system and lifecycle events
- [Skills](docs/skills.md) - Slash command usage
- [Methodology](docs/methodology.md) - Reasoning methodologies (HOW files)
- [Discuss](docs/discuss.md) - Discuss system design
- [Build System](docs/build-system.md) - Build pipeline
- [Configuration](docs/configuration.md) - Environment variables and config files

---

## Statusline

Optional real-time HUD for Claude Code sessions:

```
/coral:statusline install

# after install:
opus 4.6 │ 5h:39% (1:23) wk:36% (5.2d) │ ctx:58% │ $1.57 50m │ coral:analyze
gpt-5.4  │ 5h: 0% (4:59) wk:22% (2.8d) │ spark 5h: 3% (0:47) wk: 1% (6.8d)
```

- **Line 1 (always)**: model, Claude rate limits, context usage, session ID, last active skill
- **Line 2 (optional)**: Codex model and rate limits - shown only when Codex is installed

To remove: `/coral:statusline uninstall`

## Development

```bash
npm install
npm run build     # TypeScript compile + esbuild bundle
npm test          # Run tests with vitest
```

### Git Workflow

- **`main`**: Release branch. Always deployable.
- **`dev`**: Integration branch. Direct commits allowed for small changes.
- **Feature branches**: Branch from `dev`, rebase merge back via PR.
- **Release**: Squash merge `dev` → `main` via PR.

Merge policy:
- **feature → dev**: rebase (preserve individual commits)
- **dev → main**: squash (one commit per release, traceable via `(#N)`)
