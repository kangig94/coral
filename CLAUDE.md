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

**Hard rule: Never write directly to `kb/`. The only path is memo → promotion. No exceptions, all contexts.**

## Memo
On non-obvious discovery during any phase (review, planning, implementation), write immediately to:
`.coral/memo/<timestamp>-<topic>.md` — one paragraph + context.
Also memo Insights worth preserving when Explanatory output style is active.

## Lookup
Before debugging from scratch, check `.coral/kb/`. On plan start, review domain-related kb files.

## Promotion
**Who**: top-level orchestrator only, after all work completes (not implementation — after review too).
Subagents and delegated tasks only write memos, never promote.

**Process**: review all memos, check existing kb entries — discard duplicates, update existing, create only for genuinely absent knowledge. Delete processed memos.

**Format** — `.coral/kb/<domain>-<topic>.md`:

    # <Title>
    Promoted: <YYYY-MM-DD> | Updated: <YYYY-MM-DD>
    ## Rule
    One paragraph - state the lesson directly.
    ## Why
    What goes wrong without this knowledge.
    ## Pattern
    Right vs wrong approach - code blocks or examples.

## Invalidation
If a kb entry contradicts current code, update or delete it immediately.
