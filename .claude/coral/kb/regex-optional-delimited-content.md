# Regex: Optional Content Between Delimiters Requires Optional Group

## Rule
When matching a delimited block whose content may be entirely absent, wrap the inner match in an optional group `(content\r?\n)?` — not just `content\r?\n`. Without the `?`, the regex requires at least one character before the closing delimiter and silently fails to match empty blocks.

## Why
A pattern like `/^---\r?\n[\s\S]*?\r?\n---/` requires at least one character + newline between the delimiters. An empty block (`---\n---`) has nothing between them, so the engine tries to match `[\s\S]*?` followed by `\r?\n` — which fails because the closing `---` is immediately adjacent. Making the inner group optional allows the pattern to match when content is absent.

## Pattern
```typescript
// WRONG: requires at least one content line — fails on ---\n---\n
content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

// RIGHT: the entire content group is optional — handles both empty and populated blocks
content.replace(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/, '');
```

## Context
`src/runner/coral-resolver.ts` `stripAgentMetadata` — the red-attacker test for empty frontmatter (`---\n---\n# Body`) exposed this. The fix changed `[\s\S]*?\r?\n` to `([\s\S]*?\r?\n)?`.
