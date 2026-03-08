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

## Memo - during work (including planning)
When you discover something non-obvious (painful root cause, unexpected gotcha,
"wish I knew earlier" pattern, or an exceptionally clever solution), write immediately to:
`.claude/coral/memo/<timestamp>-<topic>.md`
Keep brief - one paragraph + context.
If Explanatory/Learning output style is active, also memo any Insights worth preserving.

**Never write directly to `kb/` during work.** Always write to `memo/` first.
This applies to all execution contexts including subagents and delegated tasks.

## Lookup - on error
Before debugging from scratch, check `{project}/.claude/coral/kb/` for relevant entries.
On plan start, review domain-related kb files.

## Promotion - orchestrator only, after all work completes
Only the top-level orchestrator (the main session driving the task) promotes memos to kb.
Subagents and delegated tasks must never promote — they only write memos.

Promotion triggers: before commit, on task completion, or when a memo captures a reusable lesson.
Review all memos. Check existing kb entries first - discard duplicates,
update existing entries if the memo refines them, only create new files for genuinely absent knowledge.

Promote to `{project}/.claude/coral/kb/<domain>-<topic>.md`:

    # <Title>
    ## Rule
    One paragraph - state the lesson directly.
    ## Why
    What goes wrong without this knowledge.
    ## Pattern
    Right vs wrong approach - code blocks or examples.

Clean up promoted sources: delete processed memos.

## Invalidation
If a kb entry contradicts current code, update or delete it immediately.
