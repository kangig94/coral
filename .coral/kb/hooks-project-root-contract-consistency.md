# Hook lifecycle project-root contract must stay consistent
## Rule
If a hook workflow keys files or cleanup off `CLAUDE_PROJECT_DIR ?? input.cwd`, every phase in that workflow has to resolve project root with the same contract. Do not let write/read hooks use stdin `cwd` fallback while delayed cleanup stays env-only.
## Why
Mixed project-root resolution silently splits one logical snapshot set across different directories. Write/read may land under the real project root while cleanup scans `.` or some unrelated cwd, so stale files linger and follow-up phases miss or fail to delete the same artifacts.
## Pattern
Right:
```text
write hook    -> projectRoot = CLAUDE_PROJECT_DIR ?? input.cwd
read hook     -> projectRoot = CLAUDE_PROJECT_DIR ?? input.cwd
cleanup hook  -> projectRoot = CLAUDE_PROJECT_DIR ?? input.cwd
```

Wrong:
```text
write/read -> CLAUDE_PROJECT_DIR ?? input.cwd
cleanup    -> CLAUDE_PROJECT_DIR || '.'
```
