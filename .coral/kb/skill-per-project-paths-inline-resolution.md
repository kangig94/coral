# SKILL Files Need Inline Per-Project Path Resolution
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
If a `SKILL.md` instruction needs a per-project path, the skill must derive it explicitly inside the skill flow, typically from `git remote get-url origin` with a `local/dirname` fallback. Do not assume placeholders substituted into injected `INJECT.md` content will also be expanded inside `SKILL.md`.
## Why
`INJECT.md` placeholder substitution only happens at specific injection points such as session-start hooks or provider executors. Skills are loaded as raw instructions. A skill that writes to `{{CORAL_PROJECTS}}/...` without its own resolution step leaves the model guessing about a value that was never actually materialized in the skill text.
## Pattern
Right:
```text
1. Resolve source from `git remote get-url origin`
2. Compute slug = source.replace("/", "-")
3. Write to ~/.coral/projects/{slug}/plans/{topic}.md
```

Wrong:
```text
Write to {{CORAL_PROJECTS}}/plans/{topic}.md
```
