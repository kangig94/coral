# disable-model-invocation is only for pure pass-through skills

## Rule
`disable-model-invocation: true` in SKILL.md frontmatter prevents Claude from using its own reasoning during skill execution. Only use this for skills where Claude acts as a pure router/pass-through with zero verification logic. Any skill where Claude reads files, compares against plans, or fixes discrepancies requires model invocation.

## Why
`codex-ralph` had this flag but its Post-Completion Review phase requires Claude to read every changed file, compare against the plan, and fix discrepancies directly — all of which need model reasoning. The flag silently degraded the verification loop.

## Pattern
```yaml
# WRONG: skill has verification logic but blocks model invocation
---
name: codex-ralph
disable-model-invocation: true  # breaks Post-Completion Review
---

# RIGHT: only pure delegation with no Claude reasoning
---
name: codex-passthrough
disable-model-invocation: true  # Claude just forwards, never reasons
---

# RIGHT: skill with verification keeps model invocation enabled
---
name: codex-ralph
model: sonnet  # Claude verifies after Codex executes
---
```
