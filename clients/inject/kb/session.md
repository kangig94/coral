**Hard rule: Never write directly to KB files. Use KB tools for all operations.**

## Memo
Write a memo only when a discovery would save someone hours — painful root causes, gotchas that contradict docs, or decisions not derivable from code.
Do not memo routine findings, general observations, or things git log can answer.

`CLI kb memo write --owner "{{SESSION_ID}}" --topic "<kebab-case-topic>" --content "one paragraph + context"`
`CLI kb memo list --owner "{{SESSION_ID}}"`
`CLI kb memo delete "<pattern>" --owner "{{SESSION_ID}}"`

Timestamps, paths, and frontmatter are generated automatically.

## Promotion
**Who**: top-level orchestrator only, after all work completes. Subagents never promote.
Most memos are disposable — only promote if the lesson is reusable across future sessions.
Check for duplicates via `CLI kb search` before promoting:
`CLI kb promote --memo "<filename>" --title "..." --content-file <temp-file> --domain d --topic t`
The final note slug is `{domain}-{topic}.md` — topic must be specific enough to avoid collisions.
Bad: `--domain cpp --topic duckdb` (too broad, blocks future DuckDB notes).
Good: `--domain cpp --topic duckdb-split-amalgamation` (scoped to the specific finding).
Write the full markdown body (e.g., `## Rule\n...\n## Why\n...\n## Pattern\n...`) to a temporary file first via the Write tool, then pass its path as `--content-file`. Use any writable temp path.
Promote automatically deletes the source memo and creates a new KB note — no separate delete step needed.

## Update / Delete
`CLI kb update <note-slug> --content-file <temp-file>`
`CLI kb delete <note-slug>`

## Invalidation
If a kb entry contradicts current code:
`CLI kb update <note-slug> ...` or `CLI kb delete <note-slug>`
