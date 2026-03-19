# Skills with model: Field Run in Main Session

## Rule
Skills with `model: sonnet` (or other model values) in SKILL.md frontmatter run in the main session with the base model switched — they are NOT spawned as subagents. This means Stop hooks, session state, and all main-session mechanisms apply normally during skill execution. Subagents are only created via the Agent tool.

## Why
Confusing `model:` frontmatter with subagent spawning leads to incorrect architectural assumptions. For iterative loop patterns (like ralph-loop), knowing that skills run in the main session means Stop hooks can intercept skill exits and re-inject prompts directly.

## Pattern
```
# Skill frontmatter — runs in main session, model switched to sonnet
---
model: sonnet
---
# Stop hooks WILL fire when this skill's session turn ends

# Agent tool — spawns a separate subagent process
Agent(subagent_type: "general-purpose", prompt: "...")
# Stop hooks do NOT apply to this subagent
```

Implication: coral:ralph can adopt ralph-loop's Stop hook + state file pattern without any architectural changes, since it already runs in the main session.
