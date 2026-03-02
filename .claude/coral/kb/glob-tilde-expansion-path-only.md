# Glob ~ expands in path parameter only, not in pattern

## Rule
The Glob tool expands `~` to the home directory in the `path` parameter but NOT in `pattern`. LLMs frequently resolve `~` to CWD before passing it to the tool — instruct them to pass `~` literally.

## Why
`Glob(pattern: "~/.claude/plugins/...")` fails silently (no matches). LLMs may also expand `~` as `.` (CWD-relative), producing wrong paths like `/project/.claude/plugins/` instead of `/home/user/.claude/plugins/`.

## Pattern
```
# WRONG — ~ not expanded in pattern
Glob(pattern: "~/.claude/plugins/cache/coral/**/agents/resolver.md")

# WRONG — $HOME not expanded at all
Glob(pattern: "**/agents/resolver.md", path: "$HOME/.claude/plugins/cache/coral/")

# RIGHT — ~ expands in path
Glob(pattern: "**/agents/resolver.md", path: "~/.claude/plugins/cache/coral/")

# Agent files must include:
> Pass `~` literally to the Glob tool — it expands to the home directory. Do not resolve it yourself.
```
