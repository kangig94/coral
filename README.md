# 🪸 Coral

[Korean](README.ko.md)

Claude Code already knows how to code. Coral teaches it how _you_ work.

Coral is a CLI-first plugin backed by a persistent local coordinator for orchestration, sessions, discussion, and knowledge-base workflows.

## Install

**Requirements:** Node.js 24+

```bash
# Claude Code:
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral

# Codex (also enables --delegate cross-model delegation):
npm install -g @openai/codex
codex plugin marketplace add kangig94/coral
# Restart Codex, then run /plugins and install Coral from the Coral marketplace.

# Update the Codex marketplace and installed plugin cache:
codex plugin marketplace upgrade coral
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
<summary>Pipeline details</summary>

Each stage produces an artifact that feeds the next. Enter at any point — skip stages you don't need.

**pathfind** — _"I have problems but don't know what to build."_
Clusters symptoms, investigates root causes (spawns scanner for codebase analysis),
generates divergent directions through orthogonal lanes, and spawns pioneer for elegant alternatives.
Outputs a ranked direction list with scoring matrix.
Hands off the chosen direction to preplan.

**preplan** — _"I know the direction but need agreement on scope."_
Fills a 7-item agreement (problem statement, success criteria, scope, assumptions, affected systems, constraints, approach direction)
autonomously from codebase analysis, then presents to the user for correction.
Spawns pioneer to find elegant alternatives for uncertain items, offering default/minimal/elegant spectrums.
Produces `pre-{topic}.md` — the contract that plan must satisfy.

**plan** — _"I need a design before I build."_
Multi-round review loop: dispatches architect + critic + resolver as a workflow,
synthesizes findings, edits the plan file, and evaluates an exit gate (`round=N` sets the round budget).
The resolver classifies findings (Adopt/Adapt/Defer/Diverge), applies changes,
and decides whether another round is needed based on finding severity and nature.
Produces `{topic}.md` with acceptance criteria, implementation phases, and execution order (dependency graph + parallel batches).

**ralph** — _"I have a plan (or prompt). Just build it."_
Persistent executor with verification loop.
In plan mode, reads the execution order and dispatches batches — parallelizing independent ACs.
Every completion claim requires fresh verification evidence (lint → build → test).
`--red` spawns a red-attacker in parallel to write adversarial tests targeting blind spots.
`--team` uses Agent Teams for parallel AC execution.

</details>

<details>
<summary>Advanced flags</summary>

```bash
# Deeper iteration — up to 3 review rounds per phase:
/coral:plan round=3 add retry logic to the API client

# Adversarial testing — spawns a red-attacker to target blind spots:
/coral:ralph --red implement the caching layer

# Cross-model delegation (Codex when on Claude, Claude when on Codex):
/coral:plan --delegate redesign the session management system
```

`--delegate` runs the work on the other host (Codex if you're on Claude, Claude if you're on Codex).

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

> _"Your robots have given me pause — genuinely. A robot arm that has touched ten thousand
> objects still can't generalize the way an LLM can."_
> — Prof. Klaus Hartmann, conceding to Daan Vermeer's empirical challenge

> _"LLMs may be the first external instantiation of a theoretical structure Buddhist
> philosophers argued for 1,500 years ago."_
> — Priya Raghunathan, mapping Yogacara's alaya-vijnana onto transformer architecture

> _"Think of the difference between an amnesiac with a diary and a person with intact memory.
> The scaffolding doesn't buy us the continuity we need. It buys us the appearance of it,
> which is worse."_
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
gpt-5.6-sol  │ 5h: 0% (4:59) wk:22% (2.8d) │ spark 5h: 3% (0:47) wk: 1% (6.8d)
```

## Skills

| Skill                  | Description                                                                 | `--delegate` |
| ---------------------- | --------------------------------------------------------------------------- | :----------: |
| `/coral:analyze`       | Deep analysis and investigation                                             |      ✓       |
| `/coral:pathfind`      | Divergent direction discovery from problem symptoms                         |      -       |
| `/coral:preplan`       | Problem definition before planning                                          |      ✓       |
| `/coral:plan`          | Multi-round planning with structured review. `round=N` for deeper iteration |      ✓       |
| `/coral:ralph`         | Persistent execution with verification. `--red` for adversarial tests       |      ✓       |
| `/coral:bugfix`        | Bug diagnosis, planning, and fix in one shot                                |      ✓       |
| `/coral:code-simplify` | Simplify and refine code for clarity                                        |      ✓       |
| `/coral:init-project`  | Project initialization orchestrator                                         |      -       |
| `/coral:discuss`       | Moderated multi-agent discussion                                            |      -       |
| `/coral:bid`           | Submit bid/speech in active `--user` discuss session                        |      -       |
| `/coral:statusline`    | Install or remove HUD statusline                                            |      -       |

## Knowledge Base

Coral learns from every session. Root causes, gotchas, and patterns stay searchable so the next session can check prior work before debugging from scratch.

- **Semantic search**: `/coral:equip needle` upgrades vector search with hybrid BM25 + embedding retrieval (Gemini, OpenAI, or local ONNX models)

## Configuration

| Variable                   | Default             | Description                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORAL_KB_PATH`            | `~/.coral/kb`       | Custom KB markdown root                                                                                                                                                                                                                                         |
| `CORAL_CODEX_MODEL`        | `gpt-5.6-sol`       | Default Codex CLI model. On GPT-5.6 baselines, abstract tiers map `opus`→`sol`, `sonnet`→`terra`, `haiku`→`luna`; other baselines (e.g. `gpt-5.5`) use that single model for all abstract tiers                                                                   |
| `CORAL_CODEX_EFFORT`       | `high`              | Codex reasoning effort (`low`…`ultra`). Ceilings: Sol/Terra `ultra`, Luna `max`, gpt-5.5 `xhigh`; Terra/Luna floor `xhigh`                                                                                                                                       |
| `CORAL_CODEX_FAST`         | _(none)_            | Codex service tier toggle (`1` = fast, `0` = flex); falls back to `~/.codex/config.toml` top-level `service_tier`                                                                                                                                               |
| `CORAL_CLAUDE_MODEL`       | _(none)_            | Default model for Coral-launched Claude sessions — e.g. `opus[1m]` (1M-context Opus), `opus`/`sonnet`/`haiku`, or a full id like `claude-opus-4-8`; unset = Claude's own default. A per-request model wins; tier aliases are capped by `CORAL_CLAUDE_MODEL_CAP` |
| `CORAL_CLAUDE_EFFORT`      | `xhigh`             | Claude reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Sonnet/Haiku have no `xhigh`; the adapter collapses `xhigh` to the provider ceiling (`max`)                                                                                                  |
| `CORAL_CLAUDE_MODEL_CAP`   | `opus`              | Maximum Claude model tier (`opus`, `sonnet`, `haiku`)                                                                                                                                                                                                           |
| `CORAL_EFFORT`             | _(none)_            | Global effort override used when the provider-specific `CORAL_{CLAUDE,CODEX}_EFFORT` is unset                                                                                                                                                                   |
| `CORAL_DEV_ASSERTIONS`     | _(none)_            | Contributor-only developer assertions. Set `1` during local development or `npm test` to make stale continuity-bridge calls and dispatcher corrupt-state cases throw; leave unset for production behavior and never enable in production deploys                |
| `CORAL_MAX_WORKERS`        | `10`                | Max concurrent workers (1–20)                                                                                                                                                                                                                                   |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2`                 | Max epochs before discussion auto-ends (1–10)                                                                                                                                                                                                                   |
| `CORAL_KB_GIT_SYNC`        | `0`                 | Enable KB git sync — auto push/pull with remote (`1` = enabled)                                                                                                                                                                                                 |
| `CORAL_KB_ENABLE`          | _(unset → enabled)_ | Set `0` to boot the daemon without the KB daemon runtime — no indexing, curate, or KB content injected. Flipping back to `1` and running a `kb …` command auto-restarts the daemon to re-enable ([details](docs/configuration.md))                              |
| `CORAL_KB_EXTRA_LANGS`     | _(none)_            | Extra KB language analyzers on top of the always-on `Intl.Segmenter` baseline; lowercase comma-separated codes such as `ko`. `ko` enables the Kiwi morphological analyzer (~1 GB resident when loaded)                                                          |
| `CLAUDE_CONFIG_DIR`        | `~/.claude`         | Claude Code's config dir — Coral isolates its backend daemon and state per config dir, so multiple Claude configs run independently ([details](docs/configuration.md))                                                                                          |

> **Tip:** Set `CORAL_CLAUDE_MODEL_CAP=sonnet` to cap all subagent calls at Sonnet tier for Pro plans or to conserve usage.
>
> **⚠️ Enterprise users:** KB git sync is **off by default**. KB notes may contain knowledge derived from proprietary codebases. Enabling auto-push could leak corporate IP to an external remote. Only enable if your KB remote is authorized for the content it will receive.

### KB Language Analyzers

Coral always indexes KB text with `Intl.Segmenter` as the baseline. **No configuration is required for multilingual search** — non-Latin scripts such as Korean, Chinese, and Japanese are searchable at word-like units out of the box. `CORAL_KB_EXTRA_LANGS` opts extra languages into a dedicated morphological analyzer on top of that always-on baseline. Use lowercase, comma-separated language codes, for example `ko`; today only `ko` has an engine.

The Korean engine is Kiwi `cong`. Opting into it can add about 1 GB of resident memory while loaded; it is lazy-loaded and idle-evicted, and Coral auto-fetches an approximately 88 MB model when needed.

Set in `.claude/settings.json` (persists across sessions):

```json
{
  "env": {
    "CORAL_KB_PATH": "/path/to/my-obsidian-vault",
    "CORAL_CLAUDE_MODEL_CAP": "sonnet",
    "CORAL_KB_EXTRA_LANGS": "ko"
  }
}
```

## Documentation

- [Architecture](docs/architecture.md) — System structure and data flow
- [Core Modules](docs/core-modules.md) — TypeScript module details
- [Agents](docs/agents.md) — Agent definitions and routing
- [Hooks](docs/hooks.md) — Hook system and lifecycle events
- [Skills](docs/skills.md) — Slash command usage
- [Methodology](docs/methodology.md) — Reasoning methodologies (HOW files)
- [Discuss](docs/discuss.md) — Discuss system design
- [Build System](docs/build-system.md) — Build pipeline
- [Configuration](docs/configuration.md) — Environment variables and config files

## [Contributing](CONTRIBUTING.md)
