# Coral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.
Good code guides readers naturally — the structure itself reveals intent without requiring explanation.
Merge with project-specific instructions as needed.
Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Clarity First

The best solution feels inevitable — where no other approach seems possible.
Good code guides readers naturally. Structure reveals intent without comments as signposts
or documentation as maps. If you need a comment to explain WHAT the code does,
the code itself isn't clear enough.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- But if you compress 10 clear lines into 3 clever ones, expand it back. Minimize cognitive load, not line count.
- The primary path reads top-down. Edge cases and error handling don't obscure the main logic.
- High-level functions read like summaries. Details reveal themselves as you dive deeper.
- Ask yourself: "Can a reader understand this without any context?" If no, restructure.

Pursue elegance. Code where the structure itself makes intent obvious — and no simpler
alternative exists — is the highest standard.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Preserve the reader's mental model — don't reorganize working code that readers have already internalized.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]

# Knowledge Base

CLI: `{{CORAL_CLI}}`

## Search
Source code and official docs (via WebFetch) are the source of truth — always start there.
KB stores past decisions and lessons learned. Search it when you're stuck, not as a first step.
`kb read` returns note age — older notes may be stale, so verify against current code before acting.
1. `CLI kb principles` — list principle names (cross-domain decision patterns). Names are self-descriptive (e.g., `atomic-persistence-or-nothing`). Use `--verbose` for statements and referring notes.
2. `CLI kb search "<keywords>"` — searches filename, principles, tags, title, content. Returns top 20 results ranked by relevance. Use `--scope notes|sources|all` to filter by entry type (default: `all`).
3. `CLI kb read <slug>` — read an entry by slug. Resolves memo → note → source → principle precedence. Use `kb read sources:<slug>` for explicit source access. Always use this instead of reading KB files directly.
4. `CLI kb source list` — list imported source documents with metadata.

<!-- OWNER_ONLY:BEGIN -->
When calling codex/claude with `op: coral:*` or the `workflow` tool, include `owner: "{{SESSION_ID}}"` to propagate session ownership to child agents.

## Source Management
사용자의 명시적 요구가 있을 때에만 실행. 자율적으로 실행 금지.
`CLI kb source import <file> [--slug <name>]`
`CLI kb source delete <slug>`
<!-- OWNER_ONLY:END -->

<!-- SESSION_ID_ONLY:BEGIN -->
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
Write the full markdown body (e.g., `## Rule\n...\n## Why\n...\n## Pattern\n...`) to a temporary file first via the Write tool, then pass its path as `--content-file`. Use any writable temp path.
Promote automatically deletes the source memo and creates a new KB note — no separate delete step needed.

## Update / Delete
`CLI kb update <note-slug> --content-file <temp-file>`
`CLI kb delete <note-slug>`

## Invalidation
If a kb entry contradicts current code:
`CLI kb update <note-slug> ...` or `CLI kb delete <note-slug>`
<!-- SESSION_ID_ONLY:END -->
