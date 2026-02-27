# Coral

Claude Code already knows how to code. Coral teaches it how *you* code.

Your conventions enforced, your workflow structured, your decisions examined from multiple
angles - all through slash commands that work in any Claude Code session.

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

Coral reads your project and returns a structured analysis: architecture, modules, entry
points, and dependencies. No files written, no configuration required.

## Choose Your Path

### Structure my project

https://github.com/user-attachments/assets/881f1a14-9f4f-4d3d-8023-59610eb13ac4

```
/coral:init-project
```

Coral scans your stack, plans with reviewer verification, and generates `.claude/` -
conventions, agents, architecture docs - tailored to your project. Claude follows your
rules, not generic defaults.

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
+     review-orchestrator.md  ← final validation gate
+     ...                     ← domain agents (React, Go, ML, infra, etc.)
+   rules/
+     conventions.md          ← naming, git, style
+     ...                     ← domain rules, auto-activated by file path
+ docs/
+   architecture.md           ← module map, dependency graph
```

Look familiar? Browse this repository's `.claude/` folder.

---

### Get diverse perspectives

```
/coral:discuss should we use microservices or a monolith?
```

> **Requires:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `.claude/settings.json`

Multiple AI personas argue from different angles. Bid-based turn-taking surfaces the most
urgent responses first. Positions evolve through genuine cross-examination. Structured
synthesis at the end. Transcripts saved to `.claude/coral/discuss/`.

Example: **"Am I AGI?"** — Full transcript [EN](docs/examples/discuss-agi-en.md) · [KR](docs/examples/discuss-agi-kr.md)

<details>
<summary>Highlights from the discussion</summary>

A phenomenologist, a computational neuroscientist, an AI safety researcher, a robotics
engineer, and an Eastern philosophy scholar debate whether LLMs constitute AGI.
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

The panel converged on: LLMs are not AGI but a **genuinely novel temporal entity** — with
impressive competence within their characteristic timescale and unknown behavior at their
structural boundaries.

</details>

---

### Accelerate my workflow

```
/coral:plan add retry logic to the API client
/coral:debug why does session lookup return null?
/coral:ralph implement the caching layer
```

Structured planning with architect and critic review. Systematic bug diagnosis - root
cause, plan, fix. Persistent execution that verifies before declaring done.

`--red` flag spawns an adversarial agent to write tests targeting blind spots:
```
/coral:ralph --red implement the caching layer
```

For cross-model workflows with Codex:
```
/coral:plan --codex redesign the session management system
/coral:codex review auth.ts for security issues
```

Consecutive `/coral:codex` calls continue the same session. Say "new" to start fresh.

## Skills

| Skill | Description | Codex |
|-------|-------------|:-----:|
| `/coral:analyze` | Deep analysis and investigation | Optional |
| `/coral:plan` | Planning with architect/critic review | Optional |
| `/coral:ralph` | Persistent execution with verification. `--red` for adversarial tests | Optional |
| `/coral:debug` | Bug diagnosis, planning, and fix execution | Optional |
| `/coral:code-simplify` | Simplify and refine code for clarity | Optional |
| `/coral:codex` | Direct Codex CLI execution (session-persistent) | Required |
| `/coral:init-project` | Project initialization orchestrator | - |
| `/coral:discuss` | Moderated multi-agent discussion | - |
| `/coral:bid` | Submit bid/speech in active `--user` discuss session | - |
| `/coral:statusline` | HUD statusline setup | - |

`Optional` = works without Codex by default; pass `--codex` to delegate to Codex CLI.
Plans are saved to `.claude/coral/plans/`. Ralph is best for implementing an existing plan.

## Knowledge Base

Coral maintains a project-local knowledge base at `.claude/coral/kb/` - git-tracked, so
it syncs across devices.

When Claude discovers something non-obvious (a root cause, a gotcha, a pattern worth
remembering), it writes a memo immediately. On errors, it checks the KB before debugging
from scratch. On task completion, memos are reviewed and promoted to permanent entries.
Mistakes aren't repeated across sessions.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default Codex CLI model |
| `CORAL_DISCUSS_BID_THRESHOLD` | `30` | Minimum bid score (1–100) for floor eligibility in discussions |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Max epochs before discussion auto-ends (1–10) |
| `CORAL_DISCUSS_TTL_DAYS` | `30` | Days before completed discuss sessions are auto-pruned |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(unset)_ | **Required** for `/coral:discuss`. Set to `1`. |
| `ENABLE_TOOL_SEARCH` | `auto` | Lazy-load MCP tool definitions. `auto` (≥10%), `auto:5` (≥5%), `true` (always on). |

Set in `.claude/settings.json` (persists across sessions):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CORAL_DISCUSS_BID_THRESHOLD": "30",
    "CORAL_DISCUSS_MAX_EPOCHS": "2",
    "CORAL_DISCUSS_TTL_DAYS": "30",
    "ENABLE_TOOL_SEARCH": "auto:5"
  }
}
```

Or via shell: `export CORAL_CODEX_MODEL=gpt-5.3-codex`

## Documentation

- [Architecture](docs/architecture.md) - Architecture and data flow
- [MCP Tools](docs/mcp-tools.md) - Input/output specs for all MCP tools
- [Core Modules](docs/core-modules.md) - TypeScript module details
- [Agents](docs/agents.md) - Agent definitions and routing
- [Hooks](docs/hooks.md) - Hook system and lifecycle events
- [Skills](docs/skills.md) - Slash command usage
- [Discuss](docs/discuss.md) - Discuss system design
- [Build System](docs/build-system.md) - Build pipeline
- [Configuration](docs/configuration.md) - Environment variables and config files

---

## Statusline

Optional real-time HUD for Claude Code sessions:

```
/coral:statusline install

# after install:
opus 4.6      │ 5h:39% (1:23) wk:36% (5.2d) │ ctx:58% │ 50m │ coral:analyze
gpt-5.3-codex │ 5h: 0% (4:59) wk:22% (2.8d) │ spark 5h: 3% (0:47) wk: 1% (6.8d)
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
