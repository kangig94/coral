# Hook Script Syntax Check — Use `node --check`, Not stdin Pipe

## Rule
To syntax-check a Node.js ESM hook script that uses top-level `await readStdin()`, use `node --check <file>`. Do not use `node --input-type=module < hook.mjs` — it opens stdin immediately and reports "unsettled top-level await" even when the file is syntactically valid.

## Why
Hook scripts that read stdin via a Promise-based helper (`await readStdin()`) suspend at runtime waiting for stdin data. When you pipe the file as stdin content instead of passing it as a file argument, Node closes stdin immediately, leaving the await unsettled — and may exit non-zero despite the file being syntactically correct. This causes false failures in CI or local validation.

## Pattern
```bash
# Wrong: pipes file content as module source; top-level await hangs/fails
node --input-type=module < hooks/silent-failure-detector.mjs

# Right: parses and checks syntax without running the script
node --check hooks/silent-failure-detector.mjs
```
