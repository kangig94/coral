# 🪸 Coral

[한국어](README.ko.md)

Claude Code already knows how to code. Coral teaches it how *you* work.

## Install

**Requirements:** Node.js 18+

```
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral

# Codex CLI (optional — enables --codex cross-model delegation):
npm install -g @openai/codex
```

## Try It Now

Run this on any existing project:

```
/coral:analyze what does this codebase do?
```

## Structure a Project

https://github.com/user-attachments/assets/881f1a14-9f4f-4d3d-8023-59610eb13ac4

```
/coral:init-project
```

Coral scans your stack and generates `.claude/` — conventions, review agents, architecture docs — tailored to your project.

Generated agents aren't boilerplate — they encode evaluation rubrics calibrated to your project's stack and audience. Claude follows your rules, not generic defaults.

```bash
/coral:init-project                                          # existing project
/coral:init-project "React + FastAPI"                        # tech stack hint
/coral:init-project "multi-tenant SaaS REST API with Go"     # full description
```

<details>
<summary>Generated structure</summary>

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

Browse this repository's [`.claude/`](.claude/) folder for a real example.

</details>

## Plan, Build, and Fix

```
pathfind  →  preplan  →  plan  →  ralph
(explore)    (define)    (design)  (implement + verify)
```

```bash
# Know the problem, need a plan:
/coral:plan add retry logic to the API client

# Have symptoms, not sure what's wrong:
/coral:pathfind API is slow, DB hits limits, users are complaining

# Complex problem, need alignment first:
/coral:preplan race condition in the session manager

# Have a plan, just implement it:
/coral:ralph implement the caching layer

# Bug — diagnose, plan, fix in one shot:
/coral:bugfix why does session lookup return null?
```

<details>
<summary>Advanced flags</summary>

```bash
# Deep review with methodology-driven synthesis (resolver + HOW reasoning):
/coral:plan --deep add retry logic to the API client

# Adversarial testing — spawns a red-attacker to target blind spots:
/coral:ralph --red implement the caching layer

# Cross-model delegation to Codex CLI:
/coral:plan --codex redesign the session management system

# Direct Codex session (multi-turn, persistent):
/coral:codex review auth.ts for security issues
```

`--codex` delegates within a skill; `/coral:codex` opens a persistent session.

</details>

## Discuss

```
/coral:discuss should we use microservices or a monolith?
```

Multiple AI personas argue from different angles. Bid-based turn-taking, genuine cross-examination, structured synthesis at the end.

Join as a participant: `/coral:discuss --user "topic"`, then `/coral:bid` to submit your turns.

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

## Statusline

```
/coral:statusline install
```

```
opus 4.6 │ 5h:39% (1:23) wk:36% (5.2d) │ ctx:58% │ $1.57 50m │ coral:analyze
gpt-5.4  │ 5h: 0% (4:59) wk:22% (2.8d) │ spark 5h: 3% (0:47) wk: 1% (6.8d)
```

## Skills

| Skill | Description | Codex |
|-------|-------------|:-----:|
| `/coral:analyze` | Deep analysis and investigation | Optional |
| `/coral:pathfind` | Divergent direction discovery from problem symptoms | - |
| `/coral:preplan` | Problem definition before planning | Optional |
| `/coral:plan` | Multi-round planning with structured review. `--deep` for methodology-driven synthesis | Optional |
| `/coral:ralph` | Persistent execution with verification. `--red` for adversarial tests | Optional |
| `/coral:bugfix` | Bug diagnosis, planning, and fix in one shot | Optional |
| `/coral:code-simplify` | Simplify and refine code for clarity | Optional |
| `/coral:codex` | Direct Codex CLI execution (session-persistent) | Required |
| `/coral:init-project` | Project initialization orchestrator | - |
| `/coral:discuss` | Moderated multi-agent discussion | - |
| `/coral:bid` | Submit bid/speech in active `--user` discuss session | - |
| `/coral:equip` | One-touch install of MCP tools | - |
| `/coral:statusline` | Install or remove HUD statusline | - |
| `/coral:reef` | Real-time dashboard for session activity and KB state | - |

## Knowledge Base

Coral learns from every session. Root causes, gotchas, patterns — captured as memos, reviewed, and promoted to permanent knowledge at `~/.coral/kb/`. The next session checks the KB before debugging from scratch. Mistakes aren't repeated.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CORAL_KB_PATH` | `~/.coral/kb` | Custom KB storage path |
| `CORAL_CODEX_MODEL` | `gpt-5.4` | Default Codex CLI model |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Maximum Claude model tier (`opus`, `sonnet`, `haiku`) |
| `CORAL_MAX_SESSIONS` | `10` | Max concurrent CLI sessions (1–10) |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Max epochs before discussion auto-ends (1–10) |
| `CORAL_DISCUSS_TTL_DAYS` | `0` | Days before completed sessions are auto-pruned (0 = disabled) |

> **Tip:** Set `CORAL_CLAUDE_MODEL_CAP=sonnet` to cap all subagent calls at Sonnet tier for Pro plans or to conserve usage.

Set in `.claude/settings.json` (persists across sessions):

```json
{
  "env": {
    "CORAL_KB_PATH": "/path/to/my-obsidian-vault",
    "CORAL_CLAUDE_MODEL_CAP": "sonnet"
  }
}
```

## Documentation

- [Architecture](docs/architecture.md) — System structure and data flow
- [MCP Tools](docs/mcp-tools.md) — Input/output specs for all MCP tools
- [Core Modules](docs/core-modules.md) — TypeScript module details
- [Agents](docs/agents.md) — Agent definitions and routing
- [Hooks](docs/hooks.md) — Hook system and lifecycle events
- [Skills](docs/skills.md) — Slash command usage
- [Methodology](docs/methodology.md) — Reasoning methodologies (HOW files)
- [Discuss](docs/discuss.md) — Discuss system design
- [Build System](docs/build-system.md) — Build pipeline
- [Configuration](docs/configuration.md) — Environment variables and config files

## [Contributing](CONTRIBUTING.md)
