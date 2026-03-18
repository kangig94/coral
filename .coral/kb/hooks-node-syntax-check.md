# Hook Script Syntax Check — Use `node --check`, Not stdin Pipe
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
To syntax-check a Node.js ESM hook script that uses top-level `await readStdin()`, use `node --check <file>`. Do not use `node --input-type=module < hook.mjs` because that turns stdin into the module source, which conflicts with hooks that also read stdin at runtime.
## Why
Coral hook scripts commonly block on `await readStdin()`. If you pipe the file contents into `node --input-type=module`, Node consumes stdin as source code instead of as hook input and can report misleading top-level-await failures even when the file is syntactically valid.
## Pattern
```bash
# Wrong: feeds module source through stdin and conflicts with readStdin()
node --input-type=module < hooks/kb-lookup-reminder.mjs

# Right: parses the file without executing it
node --check hooks/kb-lookup-reminder.mjs
```
